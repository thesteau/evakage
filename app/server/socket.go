package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

func (s *Server) upgrade(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if !s.originAllowed(r) {
		http.Error(w, "Forbidden", 403)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "Unauthorized", 401)
		return
	}
	ip := s.clientIP(r)
	s.mu.Lock()
	if s.connections[ip] >= s.config.Limits.ConnectionsPerIP {
		s.mu.Unlock()
		http.Error(w, "Too Many Requests", 429)
		return
	}
	select {
	case <-s.ctx.Done():
		s.mu.Unlock()
		http.Error(w, "Server stopping", 503)
		return
	default:
	}
	s.connections[ip]++
	s.wg.Add(1)
	s.mu.Unlock()
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if e != nil {
		s.wg.Done()
		s.mu.Lock()
		s.connections[ip]--
		if s.connections[ip] == 0 {
			delete(s.connections, ip)
		}
		s.mu.Unlock()
		return
	}
	conn.SetReadLimit(256 << 10)
	limits := s.config.Limits
	ws := &socket{conn: conn, out: make(chan outbound, 256), done: make(chan struct{}), IP: ip, Challenge: token(), Messages: newBucket(limits.MessagesPerSecond, limits.MessageBurst), Signals: newBucket(limits.SignalsPerSecond, limits.SignalBurst), Pairs: newBucket(.5, 24)}
	s.mu.Lock()
	s.sockets[ws] = true
	s.mu.Unlock()
	defer func() {
		defer s.wg.Done()
		defer releaseIntercept(ws)
		ws.close(1000, "")
		_ = conn.CloseNow()
		s.mu.Lock()
		defer s.mu.Unlock()
		s.connections[ip]--
		if s.connections[ip] == 0 {
			delete(s.connections, ip)
		}
		delete(s.sockets, ws)
		c := s.clients[ws.ID]
		if c == nil || c.Socket != ws {
			return
		}
		s.noteSeen(ws.ID)
		delete(s.clients, ws.ID)
		s.online.Delete(ws.ID)
		delete(s.codes, c.Code)
		changed := false
		for _, r := range s.rooms {
			if r.Members[ws.ID] {
				delete(r.Members, ws.ID)
				r.Away[ws.ID] = s.config.Now()
				changed = true
			}
			// A request lasts only as long as the device that made it is here.
			if _, ok := r.Pending[ws.ID]; ok {
				delete(r.Pending, ws.ID)
				changed = true
			}
		}
		s.blobs.refresh()
		s.broadcastPresence()
		if changed {
			s.broadcastRooms()
		}
	}()
	go func() {
		defer close(ws.done)
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-ws.done:
				return
			case data := <-ws.out:
				if data.code != 0 {
					_ = conn.Close(websocket.StatusCode(data.code), data.reason)
					return
				}
				ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
				e := conn.Write(ctx, websocket.MessageText, data.data)
				cancel()
				if e != nil {
					ws.close(1001, "Write failed")
					return
				}
			}
		}
	}()
	ws.send(object{"type": "registration-challenge", "challenge": ws.Challenge})
	for {
		typ, data, e := conn.Read(s.ctx)
		if e != nil {
			return
		}
		s.mu.Lock()
		s.readMessage(ws, typ, data)
		s.mu.Unlock()
	}
}
func (s *Server) strike(ws *socket, reason string) {
	ws.Invalid++
	if ws.Invalid >= s.config.Limits.MaxInvalidMessages {
		ws.close(1008, reason)
	}
}
func errorMessage(ws *socket, m object, message string) {
	reply := object{"type": "error", "context": m["type"], "message": message}
	for _, k := range []string{"requestId", "blobId"} {
		if v, ok := m[k]; ok {
			reply[k] = v
		}
	}
	ws.send(reply)
}
func (s *Server) readMessage(ws *socket, typ websocket.MessageType, data []byte) {
	if typ != websocket.MessageText || len(data) > 256<<10 {
		s.strike(ws, "Malformed message")
		return
	}
	if !ws.Messages.take() {
		ws.close(1008, "Rate limit exceeded")
		return
	}
	var m object
	if json.Unmarshal(data, &m) != nil || m == nil {
		s.strike(ws, "Malformed message")
		return
	}
	if !validMessage(m) {
		errorMessage(ws, m, "Message rejected by the server schema.")
		s.strike(ws, "Schema violation")
		return
	}
	if str(m["type"]) == "signal" && !ws.Signals.take() {
		ws.close(1008, "Signaling rate limit exceeded")
		return
	}
	s.processRevocations()
	if str(m["type"]) == "register" {
		s.register(ws, m)
		return
	}
	c := s.clients[ws.ID]
	if c == nil || c.Socket != ws {
		return
	}
	switch str(m["type"]) {
	case "account-connect":
		session := ""
		if c.Verified {
			session = s.accounts.consume(str(m["token"]), c.ID)
		}
		if session == "" {
			errorMessage(ws, m, "Account connection rejected. Sign in again.")
			return
		}
		for _, ids := range s.sessionDevices {
			delete(ids, c.ID)
		}
		addRelationship(s.sessionDevices, session, c.ID)
		c.Session = session
		s.broadcastPresence()
	case "create-room":
		owner := s.accounts.owner(c.Session)
		if owner == "" {
			errorMessage(ws, m, "Log in to create a room. You can still join a room by code without logging in.")
			return
		}
		owned := []*room{}
		for _, r := range s.sortedRooms() {
			if r.Owner == owner {
				owned = append(owned, r)
			}
		}
		var oldest *room
		if len(owned) >= 2 {
			oldest = owned[0]
		}
		if len(s.rooms) >= s.config.MaxRooms && oldest == nil {
			errorMessage(ws, m, "This server is already hosting the maximum number of rooms.")
			return
		}
		name := str(m["name"])
		if name == "" {
			name = "Room"
		}
		code := invitation()
		for {
			taken := false
			for _, r := range s.rooms {
				if r.Code == code {
					taken = true
				}
			}
			if !taken {
				break
			}
			code = invitation()
		}
		s.nextRoomOrder++
		r := &room{ID: uuid(), Code: code, Name: clean(name), CreatedAt: s.config.Now(), Order: s.nextRoomOrder, CreatedBy: c.ID, Owner: owner, Access: roomAccess(m["access"]), Members: newSet(c.ID), Away: map[string]int64{}, Pending: map[string]int64{}}
		reply := object{"type": "room-joined", "created": true}
		if oldest != nil {
			reply["replacedRoomName"] = oldest.Name
			s.destroyRoom(oldest)
		}
		s.rooms[r.ID] = r
		reply["room"] = s.roomView(r, c.ID)
		ws.send(reply)
		s.broadcastRooms()
	case "join-room":
		var byCode *room
		code := strings.ToUpper(strings.TrimSpace(str(m["code"])))
		if code != "" {
			for _, r := range s.rooms {
				if r.Code == code {
					byCode = r
					break
				}
			}
		}
		r := byCode
		if r == nil {
			r = s.rooms[str(m["roomId"])]
		}
		reject := func() {
			reply := object{"type": "error", "context": "join-room", "message": "Unable to join with this invitation."}
			if m["recreate"] == true {
				reply["roomId"] = m["roomId"]
			}
			ws.send(reply)
		}
		if r == nil {
			reject()
			return
		}
		_, away := r.Away[c.ID]
		returning := r.Members[c.ID] || away
		// A code admits to any room; a public room can also be joined from the list.
		invited := byCode != nil || r.Access == roomPublic
		if !returning && (!invited || len(r.Members) == 0 || s.roomFull(r)) {
			reject()
			return
		}
		if !returning && r.Access == roomPrivate && !s.roomOwner(c, r) {
			if _, asked := r.Pending[c.ID]; !asked {
				r.Pending[c.ID] = s.config.Now()
			}
			ws.send(object{"type": "room-pending", "roomId": r.ID, "name": r.Name})
			s.broadcastRooms()
			return
		}
		s.admit(r, c.ID)
		s.broadcastRooms()
	case "room-approve":
		r := s.rooms[str(m["roomId"])]
		id := str(m["deviceId"])
		if r == nil || !r.Members[c.ID] || !s.roomOwner(c, r) {
			return
		}
		if _, ok := r.Pending[id]; !ok {
			return
		}
		delete(r.Pending, id)
		if p := s.clients[id]; p != nil {
			switch {
			case m["approve"] != true:
				p.Socket.send(object{"type": "error", "context": "join-room", "message": "The room owner declined your request to join " + r.Name + "."})
			case s.roomFull(r):
				p.Socket.send(object{"type": "error", "context": "join-room", "message": r.Name + " is full."})
			default:
				s.admit(r, id)
			}
		}
		s.broadcastRooms()
	case "room-access":
		r := s.rooms[str(m["roomId"])]
		if r == nil || !r.Members[c.ID] || !s.roomOwner(c, r) {
			return
		}
		r.Access = roomAccess(m["access"])
		// Without approval there is nothing left to wait for.
		if r.Access != roomPrivate {
			for _, id := range r.pendingIDs() {
				if s.roomFull(r) {
					break
				}
				s.admit(r, id)
			}
		}
		s.broadcastRooms()
	case "leave-room":
		r := s.rooms[str(m["roomId"])]
		if r != nil {
			if _, asked := r.Pending[c.ID]; asked {
				delete(r.Pending, c.ID)
				ws.send(object{"type": "room-left", "roomId": r.ID})
				s.broadcastRooms()
				return
			}
		}
		if r == nil || !s.dropSeat(r, c.ID) {
			return
		}
		ws.send(object{"type": "room-left", "roomId": r.ID})
		s.broadcastRooms()
	case "lookup-devices":
		devices := []object{}
		for _, v := range m["deviceIds"].([]any) {
			id := str(v)
			if len(c.Watched) < 200 {
				c.Watched[id] = true
			}
			if p := s.deviceRecord(id); p != nil {
				devices = append(devices, p)
			}
		}
		ws.send(object{"type": "devices-found", "requestId": m["requestId"], "devices": devices})
		ws.send(object{"type": "presence", "peers": s.visible(c.ID)})
	case "rooms-request":
		ws.send(object{"type": "rooms", "rooms": s.listedRooms(c.ID)})
	case "blob-offer":
		envelopes := obj(m["envelopes"])
		recipients := set{}
		for id := range envelopes {
			recipients[id] = true
		}
		conv := str(m["conv"])
		if !s.recipientsAllowed(c.ID, conv, recipients) {
			errorMessage(ws, m, "Those recipients are not reachable from this device.")
			return
		}
		b, msg := s.blobs.offer(c.ID, conv, str(m["kind"]), number(m["bytes"]), number(m["chunkSize"]), number(m["totalChunks"]), envelopes)
		if b == nil {
			errorMessage(ws, m, msg)
			return
		}
		s.blobs.mu.Lock()
		expires := s.blobs.expires(b)
		notices := s.blobs.notices
		s.blobs.notices = nil
		s.blobs.mu.Unlock()
		for _, notice := range notices {
			for id := range notice.Participants {
				if peer := s.clients[id]; peer != nil {
					peer.Socket.send(object{"type": "relay-notice", "message": notice.Message})
				}
			}
		}
		if b.Complete {
			s.notifyBlob(b)
		}
		reply := object{"type": "blob-offered", "requestId": m["requestId"], "blobId": b.ID, "maxAgeMs": s.config.Blobs.MaxAgeMS, "expiresAt": expires}
		if b.Kind == "file" {
			reply["uploadToken"] = b.UploadToken
		}
		ws.send(reply)
	case "blob-claim":
		reply := s.blobs.claim(str(m["blobId"]), c.ID)
		if msg := str(reply["error"]); msg != "" {
			errorMessage(ws, m, msg)
		} else {
			ws.send(reply)
		}
	case "blob-release":
		s.blobs.release(str(m["blobId"]), c.ID)
	case "blob-cancel":
		id := str(m["blobId"])
		s.blobs.mu.Lock()
		b := s.blobs.blobs[id]
		if b != nil && b.SenderID == c.ID {
			s.blobs.removeLocked(id)
		}
		s.blobs.mu.Unlock()
	case "blobs-request":
		s.deliverPending(ws)
	case "self-clear":
		s.blobs.mu.Lock()
		for _, b := range s.blobs.blobs {
			if b.SenderID == c.ID && len(b.Recipients) == 1 && b.Recipients[c.ID] {
				s.blobs.removeLocked(b.ID)
			}
		}
		s.blobs.mu.Unlock()
		ws.send(object{"type": "self-cleared"})
	case "set-discoverable":
		c.Discoverable = m["enabled"] == true
		s.noteSeen(c.ID)
		s.broadcastPresence()
	case "presence-request":
		ws.send(object{"type": "presence", "peers": s.visible(c.ID)})
	case "unpair-device":
		target := str(m["deviceId"])
		if !c.Verified || !s.paired[c.ID][target] {
			return
		}
		delete(s.paired[c.ID], target)
		delete(s.paired[target], c.ID)
		delete(c.Watched, target)
		if peer := s.clients[target]; peer != nil {
			delete(peer.Watched, c.ID)
			peer.Socket.send(object{"type": "pairing-revoked", "deviceId": c.ID})
		}
		addRelationship(s.revoked, c.ID, target)
		addRelationship(s.revoked, target, c.ID)
		ws.send(object{"type": "pairing-revoked", "deviceId": target})
		s.broadcastPresence()
	case "pair-device":
		reply := object{"type": "paired-device", "requestId": m["requestId"], "peer": nil}
		if !c.Verified || !ws.Pairs.take() {
			ws.send(reply)
			return
		}
		id := s.pairing.resolve(str(m["code"]))
		peer := s.deviceRecord(id)
		target := str(m["targetId"])
		if id == "" || peer == nil || peer["identityKey"] == nil || len(id) != 43 || id == c.ID || target != "" && target != id {
			ws.send(reply)
			return
		}
		addRelationship(s.paired, c.ID, id)
		addRelationship(s.paired, id, c.ID)
		delete(s.revoked[c.ID], id)
		delete(s.revoked[id], c.ID)
		reply["peer"] = peer
		ws.send(reply)
		s.broadcastPresence()
		if p := s.clients[id]; p != nil && p.Verified {
			p.Socket.send(object{"type": "paired-device", "peer": public(c)})
		}
	case "resolve-code":
		id := s.codes[strings.ToUpper(strings.TrimSpace(str(m["code"])))]
		var peer any
		for _, p := range s.visible(c.ID) {
			if str(p["id"]) == id {
				peer = p
			}
		}
		ws.send(object{"type": "resolved-code", "requestId": m["requestId"], "peer": peer})
	case "signal":
		target := s.clients[str(m["to"])]
		if target == nil || target.ID == c.ID || s.relationshipRevoked(c.ID, target.ID) {
			return
		}
		d := obj(m["data"])
		data := object{"type": d["type"]}
		switch str(d["type"]) {
		case "ice":
			data["candidate"] = d["candidate"]
		case "offer", "answer":
			description := obj(d["sdp"])
			data["sdp"] = object{"type": description["type"], "sdp": description["sdp"]}
		}
		target.Socket.send(object{"type": "signal", "from": c.ID, "fromConnectedAt": c.ConnectedAt, "data": data})
	}
}
func (s *Server) register(ws *socket, m object) {
	id := str(m["deviceId"])
	verified := verifyRegistration(m, ws.Challenge)
	if len(id) == 43 && !verified {
		errorMessage(ws, m, "This device is not authorized (identity proof failed).")
		ws.close(1008, "Device identity proof failed")
		return
	}
	if len(s.config.AllowedDevices) > 0 {
		allowed := false
		for _, v := range s.config.AllowedDevices {
			if v == id {
				allowed = true
			}
		}
		if !allowed || !verified {
			errorMessage(ws, m, "This device is not authorized.")
			ws.close(1008, "Device authorization failed")
			return
		}
	}
	b := s.registrations[ws.IP]
	if b == nil {
		n := float64(s.config.Limits.RegistrationsPerMinute)
		b = newBucket(n/60, n)
		s.registrations[ws.IP] = b
	}
	if !b.take() {
		ws.close(1008, "Registration rate limit exceeded")
		return
	}
	previous := s.clients[id]
	if previous == nil && len(s.clients) >= s.config.MaxDevices {
		errorMessage(ws, m, fmt.Sprintf("This server has reached its %d-device limit. Try again after a device disconnects.", s.config.MaxDevices))
		ws.close(1008, "Server device limit reached")
		return
	}
	if ws.ID != "" && ws.ID != id {
		errorMessage(ws, m, "A connection cannot change device identity.")
		ws.close(1008, "Identity changed")
		return
	}
	if previous != nil && previous.Socket != ws {
		previous.Socket.close(4001, "Replaced by reconnect")
	}
	code := s.stableCode(id)
	s.codes[code] = id
	ws.ID = id
	platform, browser := str(m["platform"]), str(m["browser"])
	if platform == "" {
		platform = "Unknown"
	}
	if browser == "" {
		browser = "Browser"
	}
	platform, browser = clean(platform), clean(browser)
	if len([]rune(platform)) > 40 {
		platform = string([]rune(platform)[:40])
	}
	if len([]rune(browser)) > 40 {
		browser = string([]rune(browser)[:40])
	}
	c := &client{Socket: ws, ID: id, Code: code, Name: "Device " + code, Platform: platform, Browser: browser, ConnectedAt: s.config.Now(), IdentityKey: m["identityKey"], SealKey: m["sealKey"], SealKeySignature: m["sealKeySignature"], Discoverable: m["discoverable"] == true, Verified: verified, Watched: set{}, RoomsSnapshot: "[]"}
	s.clients[id] = c
	s.online.Store(id, true)
	s.noteSeen(id)
	s.blobs.refresh()
	self := public(c)
	invitation := s.pairing.issue(id)
	self["pairingCode"] = invitation.Code
	self["pairingCodeExpiresAt"] = invitation.ExpiresAt
	paired := []object{}
	revoked := []string{}
	if verified {
		for _, peer := range keys(s.paired[id]) {
			if p := s.deviceRecord(peer); p != nil {
				paired = append(paired, p)
			}
		}
		revoked = keys(s.revoked[id])
	}
	ws.send(object{"type": "registered", "self": self, "paired": paired, "revoked": revoked})
	s.broadcastPresence()
	ws.send(object{"type": "rooms", "rooms": s.listedRooms(id)})
	s.deliverPending(ws)
	registeredAt := s.config.Now()
	time.AfterFunc(time.Duration(s.config.RejoinGraceMS)*time.Millisecond, func() {
		select {
		case <-s.ctx.Done():
			return
		default:
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.clients[id] != c {
			return
		}
		changed := false
		for _, r := range s.rooms {
			if since, ok := r.Away[id]; ok && since <= registeredAt {
				changed = s.dropSeat(r, id) || changed
			}
		}
		if changed {
			s.broadcastRooms()
		}
	})
}
