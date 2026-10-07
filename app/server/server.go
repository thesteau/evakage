package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type client struct {
	Socket                                           *socket
	ID, Code, Name, Platform, Browser                string
	ConnectedAt                                      int64
	IdentityKey, SealKey, SealKeySignature           any
	Discoverable, Verified                           bool
	Session                                          string
	Watched                                          set
	PresenceSnapshot, RoomsSnapshot, AccountSnapshot string
}
type room struct {
	ID, Code, Name, CreatedBy, Owner string
	// Access is roomPrivate (code joins wait for the owner's approval),
	// roomProtected (a code is enough) or roomPublic (listed to everyone).
	Access    string
	CreatedAt int64
	Order     uint64
	Members   set
	Away      map[string]int64
	// Pending holds devices that asked to join a private room, by request time.
	Pending map[string]int64
}

const (
	roomPrivate   = "private"
	roomProtected = "protected"
	roomPublic    = "public"
)

func roomAccess(v any) string {
	switch s := str(v); s {
	case roomProtected, roomPublic:
		return s
	}
	return roomPrivate
}
type recentDevice struct {
	Record   object
	LastSeen int64
}
type socket struct {
	conn                     *websocket.Conn
	out                      chan outbound
	done                     chan struct{}
	once                     sync.Once
	ID, IP, Challenge        string
	Invalid                  int
	Messages, Signals, Pairs *bucket
}
type outbound struct {
	data   []byte
	code   int
	reason string
}

func (ws *socket) send(m any) {
	if interceptSend(ws, m) {
		return
	}
	ws.sendRaw(m)
}
func (ws *socket) sendRaw(m any) {
	select {
	case <-ws.done:
		return
	default:
	}
	select {
	case ws.out <- outbound{data: encode(m)}:
	default:
		ws.close(1008, "Slow consumer")
	}
}
func (ws *socket) close(code int, reason string) {
	ws.once.Do(func() {
		select {
		case ws.out <- outbound{code: code, reason: reason}:
		default:
			_ = ws.conn.CloseNow()
		}
	})
}

// Server serializes protocol state while uploads and downloads run independently.
// The online index lets the relay assess liveness without taking the state lock.
type Server struct {
	mu                                              sync.Mutex
	config                                          Config
	http                                            *http.Server
	listener                                        net.Listener
	clients                                         map[string]*client
	rooms                                           map[string]*room
	recent                                          map[string]*recentDevice
	paired, accountDevices, sessionDevices, revoked map[string]set
	codes                                           map[string]string
	pairing                                         *pairingCodes
	sockets                                         map[*socket]bool
	connections                                     map[string]int
	registrations                                   map[string]*bucket
	accounts                                        *accounts
	blobs                                           *blobStore
	online                                          sync.Map
	ctx                                             context.Context
	cancel                                          context.CancelFunc
	wg                                              sync.WaitGroup
	stopOnce                                        sync.Once
	nextRoomOrder                                   uint64
}

func New(c Config) (*Server, error) {
	if c.Now == nil {
		c.Now = nowMS
	}
	if c.MaxDevices < 1 || c.MaxRooms < 1 || c.Port < 0 || c.Port > 65535 {
		return nil, fmt.Errorf("MAX_DEVICES and MAX_ROOMS must be positive integers and PORT must be valid")
	}
	for _, id := range c.AllowedDevices {
		if !fingerprintPattern.MatchString(id) {
			return nil, fmt.Errorf("DEVICE_ALLOWLIST must contain full device fingerprints")
		}
	}
	if c.MaxRoomMembers == 0 {
		c.MaxRoomMembers = 20
	}
	c.MaxRoomMembers = max(2, min(64, c.MaxRoomMembers))
	if c.MaxRecentDevices < 1 {
		c.MaxRecentDevices = 10000
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{config: c, clients: map[string]*client{}, rooms: map[string]*room{}, recent: map[string]*recentDevice{}, paired: map[string]set{}, accountDevices: map[string]set{}, sessionDevices: map[string]set{}, revoked: map[string]set{}, codes: map[string]string{}, pairing: newPairing(c.Now), sockets: map[*socket]bool{}, connections: map[string]int{}, registrations: map[string]*bucket{}, ctx: ctx, cancel: cancel}
	var e error
	s.accounts, e = newAccounts(c.AccountsDB, c.Now)
	if e != nil {
		cancel()
		return nil, e
	}
	s.blobs, e = newBlobStore(c.Blobs, c.Now, func(id string) bool { _, ok := s.online.Load(id); return ok })
	if e != nil {
		_ = s.accounts.close()
		cancel()
		return nil, e
	}
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	return s, nil
}
func (s *Server) Start() (net.Addr, error) {
	if e := s.blobs.wipe(); e != nil {
		return nil, e
	}
	l, e := net.Listen("tcp", net.JoinHostPort(s.config.Host, strconv.Itoa(s.config.Port)))
	if e != nil {
		return nil, e
	}
	s.listener = l
	s.wg.Add(2)
	go func() {
		defer s.wg.Done()
		if e := s.http.Serve(l); e != nil && e != http.ErrServerClosed {
			s.cancel()
		}
	}()
	go s.maintenance()
	return l.Addr(), nil
}
func (s *Server) Stop(ctx context.Context) error {
	var err error
	s.stopOnce.Do(func() {
		s.cancel()
		s.mu.Lock()
		for ws := range s.sockets {
			ws.close(1001, "Server stopping")
			_ = ws.conn.CloseNow()
		}
		s.mu.Unlock()
		err = s.http.Shutdown(ctx)
		if err != nil {
			_ = s.http.Close()
		}
		s.wg.Wait()
		if e := s.blobs.wipe(); err == nil {
			err = e
		}
		if e := s.accounts.close(); err == nil {
			err = e
		}
	})
	return err
}
func remoteIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		return r.RemoteAddr
	}
	return host
}
func (s *Server) effectiveHost(r *http.Request) string {
	host := r.Host
	if s.config.TrustProxy {
		if h := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); h != "" {
			host = h
		}
	}
	return strings.ToLower(strings.TrimSpace(host))
}
func (s *Server) clientIP(r *http.Request) string {
	if s.config.TrustProxy {
		if ip := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); ip != "" {
			return ip
		}
	}
	return remoteIP(r)
}
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if len(s.config.AllowedOrigins) > 0 {
		for _, o := range s.config.AllowedOrigins {
			if o == origin {
				return true
			}
		}
		return false
	}
	u, e := url.Parse(origin)
	return e == nil && u.Host != "" && strings.ToLower(u.Host) == s.effectiveHost(r)
}
func (s *Server) authCookie() string {
	h := hmac.New(sha256.New, []byte(s.config.AuthToken))
	_, _ = h.Write([]byte("evakage-session-v1"))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func (s *Server) authorized(r *http.Request) bool {
	if s.config.AuthToken == "" {
		return true
	}
	c, e := r.Cookie("evakage_auth")
	return e == nil && safeToken(c.Value, s.authCookie())
}

var securityHeaders = map[string]string{"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Permissions-Policy": "camera=(self), microphone=(), geolocation=()", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin"}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for k, v := range securityHeaders {
		w.Header().Set(k, v)
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		s.upgrade(w, r)
		return
	}
	path := r.URL.Path
	if path == "/healthz" {
		s.mu.Lock()
		peers := len(s.clients)
		s.mu.Unlock()
		stats := s.blobs.stats()
		jsonReply(w, 200, object{"ok": true, "peers": peers, "bufferedTransfers": stats["files"], "bufferedMessages": stats["messages"], "bufferedBytes": stats["bytes"]})
		return
	}
	if path == "/share" {
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 8<<20))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Connection", "close")
		http.Redirect(w, r, "/?shared=failed", 303)
		return
	}
	if s.config.AuthToken != "" {
		q := r.URL.Query()
		if safeToken(q.Get("token"), s.config.AuthToken) {
			q.Del("token")
			http.SetCookie(w, &http.Cookie{Name: "evakage_auth", Value: s.authCookie(), Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: s.config.TrustProxy, MaxAge: 2592000})
			target := r.URL.Path
			if encoded := q.Encode(); encoded != "" {
				target += "?" + encoded
			}
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, target, 302)
			return
		}
		if !s.authorized(r) {
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, "This Evakage server requires a token. Open it as https://host/?token=YOUR_TOKEN once.", 401)
			return
		}
	}
	if strings.HasPrefix(path, "/account/") {
		s.accounts.handle(w, r, s.effectiveHost(r), s.config.TrustProxy)
		s.mu.Lock()
		s.processRevocations()
		s.mu.Unlock()
		return
	}
	if path == "/config.json" {
		c := s.config
		s.blobs.mu.Lock()
		b := s.blobs.config
		s.blobs.mu.Unlock()
		jsonReply(w, 200, object{"accountsEnabled": c.AccountsDB != "", "iceServers": c.ICE, "maxFileBytes": b.MaxBlobBytes, "maxRoomMembers": c.MaxRoomMembers, "maxDevices": c.MaxDevices, "maxRooms": c.MaxRooms, "roomMeshMax": 6, "protocol": 3, "relay": object{"enabled": true, "chunkSize": 256 << 10, "idleGraceMs": b.IdleGraceMS, "soloMaxMs": b.SoloMaxMS, "maxAgeMs": b.MaxAgeMS, "maxStoreBytes": b.MaxStoreBytes, "textReserveBytes": min(b.TextReserveBytes, b.MaxStoreBytes/4), "maxConversationFileBytes": b.MaxConversationFileBytes, "maxConversationTextBytes": b.MaxConversationTextBytes}})
		return
	}
	if strings.HasPrefix(path, "/blob/") {
		s.blobHTTP(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", 405)
		return
	}
	if path == "/" {
		path = "/index.html"
	}
	if strings.Contains(path, "\\") || strings.ContainsRune(path, 0) {
		http.Error(w, "Forbidden", 403)
		return
	}
	target := filepath.FromSlash(strings.TrimPrefix(path, "/"))
	if !filepath.IsLocal(target) {
		http.Error(w, "Forbidden", 403)
		return
	}
	// os.Root refuses any path, including through a symlink, that leaves the
	// public directory.
	root, e := os.OpenRoot(s.config.PublicDir)
	if e != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	f, e := root.Open(target)
	if e != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if info.Name() == "index.html" {
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
	w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	if strings.HasSuffix(target, ".js") || strings.HasSuffix(target, ".mjs") {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
func (s *Server) blobHTTP(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/blob/")
	if !uuidPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	t := r.URL.Query().Get("token")
	switch r.Method {
	case "PUT", "POST":
		var offset *int64
		if r.URL.Query().Has("offset") {
			n, e := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
			if e != nil {
				http.Error(w, "Upload offset conflict.", 409)
				return
			}
			offset = &n
		}
		status, msg, b := s.blobs.receive(id, t, offset, r.Body)
		if b != nil {
			s.mu.Lock()
			s.notifyBlob(b)
			s.mu.Unlock()
		}
		if status == 204 {
			w.WriteHeader(204)
		} else {
			http.Error(w, msg, status)
		}
	case "GET":
		if offset := r.URL.Query().Get("offset"); offset != "" && offset != "0" {
			http.Error(w, "Downloads must start from the beginning.", 416)
			return
		}
		f, length, status, msg, done := s.blobs.download(id, t)
		if status != 200 {
			http.Error(w, msg, status)
			return
		}
		defer done()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.Copy(w, f)
	default:
		w.Header().Set("Allow", "GET, PUT")
		http.Error(w, "Method not allowed", 405)
	}
}
func (s *Server) stableCode(id string) string {
	h := sha256.Sum256([]byte(id))
	raw := strings.ToUpper(base64.RawURLEncoding.EncodeToString(h[:]))
	compact := strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, raw)
	for size := 8; size <= 14; size += 2 {
		c := compact[:4] + "-" + compact[4:size]
		if s.codes[c] == "" || s.codes[c] == id {
			return c
		}
	}
	return fmt.Sprintf("%X", randomBytes(6))
}
func public(c *client) object {
	return object{"id": c.ID, "code": c.Code, "name": c.Name, "platform": c.Platform, "browser": c.Browser, "connectedAt": c.ConnectedAt, "identityKey": c.IdentityKey, "sealKey": c.SealKey, "sealKeySignature": c.SealKeySignature}
}
func (s *Server) sortedClients() []*client {
	out := []*client{}
	for _, c := range s.clients {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ConnectedAt == out[j].ConnectedAt {
			return out[i].ID < out[j].ID
		}
		return out[i].ConnectedAt < out[j].ConnectedAt
	})
	return out
}
func (s *Server) sortedRooms() []*room {
	out := []*room{}
	for _, r := range s.rooms {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt == out[j].CreatedAt {
			return out[i].Order < out[j].Order
		}
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out
}
func (s *Server) accountPeers(id string) []object {
	out := []object{}
	c := s.clients[id]
	if c == nil || c.Session == "" {
		return out
	}
	name := s.accounts.name(c.Session)
	if name == "" {
		return out
	}
	for _, peer := range s.sortedClients() {
		if peer.ID != id && peer.Verified && s.accounts.name(peer.Session) == name {
			out = append(out, public(peer))
		}
	}
	return out
}
func (s *Server) visible(id string) []object {
	known := newSet(id)
	for peer := range s.paired[id] {
		known[peer] = true
	}
	if c := s.clients[id]; c != nil {
		for peer := range c.Watched {
			known[peer] = true
		}
	}
	for _, p := range s.accountPeers(id) {
		known[str(p["id"])] = true
	}
	for _, r := range s.rooms {
		if r.Members[id] || r.Away[id] != 0 {
			for peer := range r.Members {
				known[peer] = true
			}
		}
	}
	out := []object{}
	for _, c := range s.sortedClients() {
		if c.Discoverable || known[c.ID] {
			out = append(out, public(c))
		}
	}
	return out
}
func addRelationship(m map[string]set, a, b string) {
	if m[a] == nil {
		m[a] = set{}
	}
	m[a][b] = true
}
func (s *Server) broadcastPresence() {
	for _, c := range s.sortedClients() {
		peers := s.accountPeers(c.ID)
		for _, p := range peers {
			addRelationship(s.accountDevices, c.ID, str(p["id"]))
		}
		account := object{"type": "account-peers", "signedIn": s.accounts.name(c.Session) != "", "peers": peers}
		snapshot := string(encode(account))
		if snapshot != c.AccountSnapshot {
			c.AccountSnapshot = snapshot
			c.Socket.send(account)
		}
		visible := s.visible(c.ID)
		snapshot = string(encode(visible))
		if snapshot != c.PresenceSnapshot {
			c.PresenceSnapshot = snapshot
			c.Socket.send(object{"type": "presence", "peers": visible})
		}
	}
}
func (s *Server) noteSeen(id string) {
	c := s.clients[id]
	if c == nil {
		return
	}
	s.recent[id] = &recentDevice{public(c), s.config.Now()}
	for len(s.recent) > s.config.MaxRecentDevices {
		oldest := ""
		var at int64
		for id, r := range s.recent {
			if s.clients[id] == nil && (oldest == "" || r.LastSeen < at) {
				oldest, at = id, r.LastSeen
			}
		}
		if oldest == "" {
			break
		}
		delete(s.recent, oldest)
	}
}
func (s *Server) isRecent(id string) bool {
	r := s.recent[id]
	return s.clients[id] != nil || r != nil && r.LastSeen >= s.config.Now()-s.config.RecentWindowMS
}
func (s *Server) deviceRecord(id string) object {
	if c := s.clients[id]; c != nil {
		p := public(c)
		p["online"] = true
		p["lastSeen"] = s.config.Now()
		return p
	}
	r := s.recent[id]
	if r == nil || !s.isRecent(id) {
		return nil
	}
	p := object{}
	for k, v := range r.Record {
		p[k] = v
	}
	p["online"] = false
	p["lastSeen"] = r.LastSeen
	return p
}
// roomOwner reports whether a device is signed into the account that created
// the room. Any such device may approve requests and change access.
func (s *Server) roomOwner(c *client, r *room) bool {
	return c != nil && r.Owner != "" && s.accounts.owner(c.Session) == r.Owner
}

// pendingIDs lists join requests oldest first.
func (r *room) pendingIDs() []string {
	ids := make([]string, 0, len(r.Pending))
	for id := range r.Pending {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if r.Pending[ids[i]] != r.Pending[ids[j]] {
			return r.Pending[ids[i]] < r.Pending[ids[j]]
		}
		return ids[i] < ids[j]
	})
	return ids
}

// roomFull counts seats held by present and away members.
func (s *Server) roomFull(r *room) bool {
	return len(r.Members)+len(r.Away) >= s.config.MaxRoomMembers
}

// admit seats a device and tells it so. The caller broadcasts the change.
func (s *Server) admit(r *room, id string) {
	delete(r.Pending, id)
	delete(r.Away, id)
	r.Members[id] = true
	if c := s.clients[id]; c != nil {
		c.Socket.send(object{"type": "room-joined", "room": s.roomView(r, id)})
	}
}

// roomView is a member's view of a room, plus the join requests when the
// viewer owns it.
func (s *Server) roomView(r *room, viewer string) object {
	view := s.roomPublic(r)
	view["access"] = r.Access
	if s.roomOwner(s.clients[viewer], r) {
		view["owned"] = true
		requests := []object{}
		for _, id := range r.pendingIDs() {
			if c := s.clients[id]; c != nil {
				requests = append(requests, public(c))
			}
		}
		view["requests"] = requests
	}
	return view
}

// roomListing is what a non-member may see: a public room to join, or the
// room it asked to join. Never the code or who is in it.
func (s *Server) roomListing(r *room, awaiting bool) object {
	transport := "mesh"
	if len(r.Members)+len(r.Away) > 6 {
		transport = "relay"
	}
	return object{"id": r.ID, "name": r.Name, "createdAt": r.CreatedAt, "maxMembers": s.config.MaxRoomMembers, "transport": transport, "access": r.Access, "members": []object{}, "away": []object{}, "seats": len(r.Members) + len(r.Away), "awaiting": awaiting}
}

func (s *Server) roomPublic(r *room) object {
	members := []object{}
	for _, id := range keys(r.Members) {
		if c := s.clients[id]; c != nil {
			members = append(members, public(c))
		}
	}
	away := []object{}
	ids := []string{}
	for id := range r.Away {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if p := s.deviceRecord(id); p != nil {
			p["awaySince"] = r.Away[id]
			away = append(away, p)
		}
	}
	transport := "mesh"
	if len(r.Members)+len(r.Away) > 6 {
		transport = "relay"
	}
	return object{"id": r.ID, "code": r.Code, "name": r.Name, "createdAt": r.CreatedAt, "maxMembers": s.config.MaxRoomMembers, "transport": transport, "members": members, "away": away}
}
func (s *Server) listedRooms(id string) []object {
	out := []object{}
	for _, r := range s.sortedRooms() {
		_, away := r.Away[id]
		_, awaiting := r.Pending[id]
		switch {
		case r.Members[id] || away:
			out = append(out, s.roomView(r, id))
		case awaiting:
			out = append(out, s.roomListing(r, true))
		case r.Access == roomPublic && len(r.Members) > 0:
			out = append(out, s.roomListing(r, false))
		}
	}
	return out
}
func (s *Server) broadcastRooms() {
	for _, c := range s.sortedClients() {
		list := s.listedRooms(c.ID)
		snap := string(encode(list))
		if snap != c.RoomsSnapshot {
			c.RoomsSnapshot = snap
			c.Socket.send(object{"type": "rooms", "rooms": list})
		}
	}
	s.broadcastPresence()
}
func (s *Server) dropSeat(r *room, id string) bool {
	member := r.Members[id]
	_, away := r.Away[id]
	delete(r.Members, id)
	delete(r.Away, id)
	if len(r.Members)+len(r.Away) == 0 {
		delete(s.rooms, r.ID)
	}
	return member || away
}
func (s *Server) destroyRoom(r *room) {
	delete(s.rooms, r.ID)
	ids := newSet(keys(r.Members)...)
	for id := range r.Away {
		ids[id] = true
	}
	for id := range ids {
		if c := s.clients[id]; c != nil {
			c.Socket.send(object{"type": "room-destroyed", "roomId": r.ID, "name": r.Name})
		}
	}
	s.blobs.revokeConversation("room:" + r.ID)
}
func (s *Server) expireAway() bool {
	changed := false
	cutoff := s.config.Now() - s.config.RecentWindowMS
	for _, r := range s.rooms {
		for id, since := range r.Away {
			if since < cutoff {
				delete(r.Away, id)
				changed = true
			}
		}
		if len(r.Members)+len(r.Away) == 0 {
			delete(s.rooms, r.ID)
			changed = true
		}
	}
	for id, r := range s.recent {
		if s.clients[id] == nil && r.LastSeen < cutoff {
			delete(s.recent, id)
		}
	}
	return changed
}
func (s *Server) relationshipRevoked(a, b string) bool {
	for _, p := range s.accountPeers(a) {
		if str(p["id"]) == b {
			return false
		}
	}
	return s.accountDevices[a][b] && !s.paired[a][b] || s.revoked[a][b] || s.revoked[b][a]
}
func (s *Server) recipientsAllowed(sender, conv string, recipients set) bool {
	if len(recipients) == 0 {
		return false
	}
	if recipients[sender] {
		return conv == "direct" && len(recipients) == 1
	}
	if conv == "direct" {
		if len(recipients) != 1 {
			return false
		}
		for id := range recipients {
			return s.isRecent(id) && !s.relationshipRevoked(sender, id)
		}
	}
	r := s.rooms[strings.TrimPrefix(conv, "room:")]
	if r == nil || !r.Members[sender] {
		return false
	}
	for id := range recipients {
		_, away := r.Away[id]
		if !r.Members[id] && !away {
			return false
		}
	}
	return true
}
func (s *Server) processRevocations() {
	for _, session := range s.accounts.drainRevocations() {
		ids := s.sessionDevices[session]
		delete(s.sessionDevices, session)
		for id := range ids {
			c := s.clients[id]
			if c != nil && c.Session != "" && c.Session != session {
				continue
			}
			peers := newSet(keys(s.paired[id])...)
			for peer := range s.accountDevices[id] {
				peers[peer] = true
			}
			if c != nil {
				c.Session = ""
				c.Discoverable = false
				c.Watched = set{}
			}
			delete(s.paired, id)
			for _, peer := range s.clients {
				delete(peer.Watched, id)
			}
			for peer := range peers {
				if peer == id {
					continue
				}
				delete(s.paired[peer], id)
				addRelationship(s.revoked, id, peer)
				addRelationship(s.revoked, peer, id)
				if p := s.clients[peer]; p != nil {
					p.Socket.send(object{"type": "pairing-revoked", "deviceId": id})
				}
			}
			for _, r := range s.rooms {
				s.dropSeat(r, id)
			}
			s.blobs.revokeDevice(id)
			if c != nil {
				c.Socket.send(object{"type": "account-reset"})
			}
		}
		s.broadcastRooms()
	}
}
func (s *Server) notifyBlob(b *blob) {
	s.blobs.mu.Lock()
	defer s.blobs.mu.Unlock()
	if s.blobs.blobs[b.ID] != b || !b.Complete {
		return
	}
	for id := range b.Recipients {
		if c := s.clients[id]; c != nil {
			if p := s.blobs.describeLocked(b, id); p != nil {
				p["type"] = "blob-available"
				c.Socket.send(p)
			}
		}
	}
}
func (s *Server) deliverPending(ws *socket) {
	for _, item := range s.blobs.pending(ws.ID) {
		item["type"] = "blob-available"
		ws.send(item)
	}
}
func (s *Server) rotatePairingCodes() {
	for _, c := range s.clients {
		e := s.pairing.issue(c.ID)
		c.Socket.send(object{"type": "pairing-code", "code": e.Code, "expiresAt": e.ExpiresAt})
	}
	s.pairing.prune()
	for id := range s.revoked {
		if s.clients[id] == nil && s.recent[id] == nil {
			delete(s.revoked, id)
		}
	}
	for id := range s.paired {
		if s.clients[id] == nil && s.recent[id] == nil {
			delete(s.paired, id)
			for _, peers := range s.paired {
				delete(peers, id)
			}
		}
	}
	for id := range s.accountDevices {
		if s.clients[id] == nil && s.recent[id] == nil {
			delete(s.accountDevices, id)
		}
	}
}
func (s *Server) maintenance() {
	defer s.wg.Done()
	sweep := time.NewTicker(time.Duration(s.config.Blobs.SweepEveryMS) * time.Millisecond)
	pairing := time.NewTicker(time.Minute)
	heartbeat := time.NewTicker(30 * time.Second)
	defer sweep.Stop()
	defer pairing.Stop()
	defer heartbeat.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-sweep.C:
			s.blobs.sweep()
			s.mu.Lock()
			if s.expireAway() {
				s.broadcastRooms()
			}
			s.mu.Unlock()
		case <-pairing.C:
			s.mu.Lock()
			s.rotatePairingCodes()
			s.mu.Unlock()
		case <-heartbeat.C:
			s.mu.Lock()
			s.accounts.prune()
			s.processRevocations()
			list := []*socket{}
			for ws := range s.sockets {
				list = append(list, ws)
			}
			for ip, b := range s.registrations {
				if b.updated < nowMS()-600000 {
					delete(s.registrations, ip)
				}
			}
			s.mu.Unlock()
			for _, ws := range list {
				go func(ws *socket) {
					ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
					defer cancel()
					if ws.conn.Ping(ctx) != nil {
						ws.close(1001, "Heartbeat timeout")
					}
				}(ws)
			}
		}
	}
}
