//go:build testbridge

package server

// This control surface is compiled only into the test runner, never evakage.
// It lets the existing TypeScript protocol/browser tests inspect Go state.
import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type sendHook struct {
	mu       sync.Mutex
	messages []any
}

var sendHooks sync.Map

func interceptSend(ws *socket, message any) bool {
	value, ok := sendHooks.Load(ws)
	if !ok {
		return false
	}
	hook := value.(*sendHook)
	hook.mu.Lock()
	defer hook.mu.Unlock()
	if len(hook.messages) >= 256 {
		ws.close(1008, "Test interceptor overflow")
		return true
	}
	hook.messages = append(hook.messages, message)
	return true
}
func releaseIntercept(ws *socket) { sendHooks.Delete(ws) }

// These facades expose internals solely to the separate tests/go module.
// They are omitted, along with the runner, from production builds.
type TestPairing struct{ inner *pairingCodes }
type TestPairingEntry = pairingEntry

func TestNewPairing(now func() int64) *TestPairing      { return &TestPairing{newPairing(now)} }
func (p *TestPairing) Issue(id string) TestPairingEntry { return p.inner.issue(id) }
func (p *TestPairing) Resolve(code string) string       { return p.inner.resolve(code) }
func TestVerifyRegistration(m map[string]any, challenge string) bool {
	return verifyRegistration(m, challenge)
}

type TestBlob = blob
type TestStore struct{ inner *blobStore }

func TestNewStore(c BlobConfig, now func() int64, online func(string) bool) (*TestStore, error) {
	s, e := newBlobStore(c, now, online)
	return &TestStore{s}, e
}
func (s *TestStore) Wipe() error { return s.inner.wipe() }
func (s *TestStore) Offer(sender, conv, kind string, bytes, size, chunks int64, envelopes map[string]any) (*TestBlob, string) {
	return s.inner.offer(sender, conv, kind, bytes, size, chunks, envelopes)
}
func (s *TestStore) Receive(id, t string, offset *int64, r io.Reader) (int, string, *TestBlob) {
	return s.inner.receive(id, t, offset, r)
}
func (s *TestStore) Claim(id, device string) map[string]any { return s.inner.claim(id, device) }
func (s *TestStore) Pending(id string) []map[string]any     { return s.inner.pending(id) }
func (s *TestStore) Download(id, t string) (*os.File, int64, int, string, func()) {
	return s.inner.download(id, t)
}

type TestAccounts struct{ inner *accounts }
type TestAccount = account

func TestNewAccounts(file string, now func() int64) (*TestAccounts, error) {
	a, e := newAccounts(file, now)
	return &TestAccounts{a}, e
}
func (a *TestAccounts) DB() *sql.DB                           { return a.inner.db }
func (a *TestAccounts) Get(name string) (*TestAccount, error) { return a.inner.get(name) }
func (a *TestAccounts) Close() error                          { return a.inner.close() }

func applyOptions(target any, m object) {
	v := reflect.ValueOf(target).Elem()
	typ := v.Type()
	for i := 0; i < v.NumField(); i++ {
		field := typ.Field(i)
		key := strings.ToLower(field.Name[:1]) + field.Name[1:]
		aliases := map[string]string{"AccountsDB": "accountsDb", "RecentWindowMS": "recentWindowMs", "RejoinGraceMS": "rejoinGraceMs", "IdleGraceMS": "idleGraceMs", "SoloMaxMS": "soloMaxMs", "MaxAgeMS": "maxAgeMs", "SweepEveryMS": "sweepEveryMs", "ConnectionsPerIP": "connectionsPerIp"}
		if a := aliases[field.Name]; a != "" {
			key = a
		}
		input, ok := m[key]
		if !ok || input == nil {
			continue
		}
		f := v.Field(i)
		switch f.Kind() {
		case reflect.String:
			f.SetString(str(input))
		case reflect.Bool:
			f.SetBool(input == true)
		case reflect.Int, reflect.Int64:
			f.SetInt(number(input))
		case reflect.Float64:
			if n, ok := input.(float64); ok {
				f.SetFloat(n)
			}
		case reflect.Slice:
			if list, ok := input.([]any); ok {
				out := []string{}
				for _, x := range list {
					out = append(out, str(x))
				}
				f.Set(reflect.ValueOf(out))
			}
		}
	}
}
func blobSnapshot(b *blob) object {
	return object{"id": b.ID, "kind": b.Kind, "senderId": b.SenderID, "conv": b.Conv, "bytes": b.Bytes, "chunkSize": b.ChunkSize, "totalChunks": b.TotalChunks, "recipients": keys(b.Recipients), "participants": keys(b.Participants), "released": keys(b.Released), "uploadToken": b.UploadToken, "path": b.Path, "envelopePath": b.EnvelopePath, "convDir": b.Dir, "envelopeBytes": b.EnvelopeBytes, "written": b.Written, "complete": b.Complete, "uploading": b.Uploading, "activeDownloads": b.ActiveDownloads, "createdAt": b.CreatedAt, "idleSince": b.IdleSince, "soloSince": b.SoloSince}
}
func configSnapshot(c any) object {
	data := encode(c)
	var m object
	_ = json.Unmarshal(data, &m)
	out := object{}
	for k, v := range m {
		key := strings.ToLower(k[:1]) + k[1:]
		if strings.HasSuffix(k, "MS") {
			key = strings.ToLower(k[:1]) + k[1:len(k)-2] + "Ms"
		}
		if k == "ConnectionsPerIP" {
			key = "connectionsPerIp"
		}
		out[key] = v
	}
	return out
}
func (s *Server) bridgeSnapshot() object {
	clients := object{}
	for id, c := range s.clients {
		p := public(c)
		p["deviceId"] = id
		p["accountSession"] = c.Session
		clients[id] = p
	}
	rooms := object{}
	for id, r := range s.rooms {
		p := s.roomPublic(r)
		p["members"] = keys(r.Members)
		p["away"] = r.Away
		rooms[id] = p
	}
	recent := object{}
	for id, r := range s.recent {
		recent[id] = object{"record": r.Record, "lastSeen": r.LastSeen}
	}
	s.blobs.mu.Lock()
	defer s.blobs.mu.Unlock()
	blobs := object{}
	for id, b := range s.blobs.blobs {
		blobs[id] = blobSnapshot(b)
	}
	roomOrder := []string{}
	for _, r := range s.sortedRooms() {
		roomOrder = append(roomOrder, r.ID)
	}
	return object{"roomsOrder": roomOrder, "clients": clients, "rooms": rooms, "recentDevices": recent, "blobs": blobs, "blobConfig": configSnapshot(s.blobs.config), "limits": configSnapshot(s.config.Limits)}
}

// RunTestBridge runs a isolated server controlled through a separate, random,
// authenticated loopback port. Production builds omit this entire file.
func RunTestBridge() error {
	var options object
	if e := json.NewDecoder(os.Stdin).Decode(&options); e != nil {
		return e
	}
	c := DefaultConfig()
	applyOptions(&c, options)
	applyOptions(&c.Blobs, obj(options["blobs"]))
	applyOptions(&c.Limits, obj(options["limits"]))
	var pairClock, blobClock atomic.Int64
	pairClock.Store(-1)
	blobClock.Store(-1)
	clock := func(v *atomic.Int64) func() int64 {
		return func() int64 {
			if n := v.Load(); n >= 0 {
				return n
			}
			return nowMS()
		}
	}
	s, e := New(c)
	if e != nil {
		return e
	}
	s.pairing.now = clock(&pairClock)
	s.blobs.now = clock(&blobClock)
	var downloads atomic.Int64
	handler := s.http.Handler
	s.http.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/blob/") {
			downloads.Add(1)
		}
		handler.ServeHTTP(w, r)
	})
	address, e := s.Start()
	if e != nil {
		return e
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.Stop(ctx)
	}()
	control, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		return e
	}
	secret := token()
	stopping := make(chan struct{}, 1)
	api := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !safeToken(r.Header.Get("Authorization"), secret) {
			http.Error(w, "Forbidden", 403)
			return
		}
		var call object
		if r.URL.Path == "/receive" {
			data := r.URL.Query().Get("input")
			if json.Unmarshal([]byte(data), &call) != nil {
				http.Error(w, "bad input", 400)
				return
			}
		} else if json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&call) != nil {
			http.Error(w, "bad input", 400)
			return
		}
		if n, ok := call["pairingNow"].(float64); ok {
			pairClock.Store(int64(n))
		}
		if n, ok := call["blobNow"].(float64); ok {
			blobClock.Store(int64(n))
		}
		action := str(call["action"])
		if action == "stop" {
			jsonReply(w, 200, object{})
			select {
			case stopping <- struct{}{}:
			default:
			}
			return
		}
		if r.URL.Path == "/receive" {
			var offset *int64
			if call["offset"] != nil {
				n := number(call["offset"])
				offset = &n
			}
			status, msg, b := s.blobs.receive(str(call["id"]), str(call["token"]), offset, r.Body)
			if b != nil {
				s.mu.Lock()
				s.notifyBlob(b)
				s.mu.Unlock()
			}
			jsonReply(w, 200, object{"status": status, "message": msg})
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		var result any = object{}
		switch action {
		case "snapshot":
			result = s.bridgeSnapshot()
		case "set":
			target, id, field := str(call["target"]), str(call["id"]), str(call["field"])
			v := call["value"]
			switch target {
			case "client":
				if c := s.clients[id]; c != nil {
					if field == "accountSession" {
						c.Session = str(v)
					}
					if field == "connectedAt" {
						c.ConnectedAt = number(v)
					}
				}
			case "recent":
				if r := s.recent[id]; r != nil {
					r.LastSeen = number(v)
				}
			case "away":
				if r := s.rooms[id]; r != nil {
					r.Away[field] = number(v)
				}
			case "blobConfig":
				s.blobs.mu.Lock()
				applyOptions(&s.blobs.config, object{field: v})
				s.blobs.mu.Unlock()
			case "blob":
				s.blobs.mu.Lock()
				if b := s.blobs.blobs[id]; b != nil {
					n := number(v)
					switch field {
					case "createdAt":
						b.CreatedAt = n
					case "idleSince":
						if v == nil {
							b.IdleSince = nil
						} else {
							b.IdleSince = &n
						}
					case "soloSince":
						if v == nil {
							b.SoloSince = nil
						} else {
							b.SoloSince = &n
						}
					}
				}
				s.blobs.mu.Unlock()
			}
		case "close":
			if c := s.clients[str(call["id"])]; c != nil {
				code := number(call["code"])
				if code == 0 {
					code = 1000
				}
				c.Socket.close(int(code), str(call["reason"]))
			}
		case "send":
			if c := s.clients[str(call["id"])]; c != nil {
				c.Socket.sendRaw(call["message"])
			}
		case "intercept":
			if c := s.clients[str(call["id"])]; c != nil {
				sendHooks.Store(c.Socket, &sendHook{})
			}
		case "intercepted":
			result = []any{}
			if c := s.clients[str(call["id"])]; c != nil {
				if value, ok := sendHooks.Load(c.Socket); ok {
					hook := value.(*sendHook)
					hook.mu.Lock()
					result = hook.messages
					if hook.messages == nil {
						result = []any{}
					}
					hook.messages = nil
					hook.mu.Unlock()
				}
			}
		case "expireAway":
			result = s.expireAway()
		case "rotatePairingCodes":
			s.rotatePairingCodes()
		case "refreshLiveness":
			s.blobs.refresh()
		case "sweepAged":
			result = s.blobs.sweep()
		case "stats":
			result = s.blobs.stats()
		case "downloads":
			result = downloads.Load()
		case "offer":
			m := obj(call["input"])
			b, msg := s.blobs.offer(str(m["senderId"]), str(m["conv"]), str(m["kind"]), number(m["bytes"]), number(m["chunkSize"]), number(m["totalChunks"]), obj(m["envelopes"]))
			if b == nil {
				result = object{"error": msg}
			} else {
				result = object{"blob": blobSnapshot(b)}
				if b.Complete {
					s.notifyBlob(b)
				}
			}
		case "claim":
			reply := s.blobs.claim(str(call["id"]), str(call["device"]))
			if str(reply["error"]) != "" {
				result = reply
			} else {
				s.blobs.mu.Lock()
				reply["blob"] = blobSnapshot(s.blobs.blobs[str(call["id"])])
				s.blobs.mu.Unlock()
				result = reply
			}
		case "pendingFor":
			result = s.blobs.pending(str(call["device"]))
		case "remove":
			s.blobs.remove(str(call["id"]))
		case "release":
			s.blobs.release(str(call["id"]), str(call["device"]))
		case "revokeDevice":
			s.blobs.revokeDevice(str(call["device"]))
		case "revokeConversation":
			s.blobs.revokeConversation(str(call["conv"]))
		case "expiresAt":
			s.blobs.mu.Lock()
			if b := s.blobs.blobs[str(call["id"])]; b != nil {
				result = s.blobs.expires(b)
			}
			s.blobs.mu.Unlock()
		case "openForDownload":
			f, _, status, msg, done := s.blobs.download(str(call["id"]), str(call["token"]))
			if f != nil {
				done()
			}
			result = object{"status": status, "message": msg}
		case "beginDownload", "finishDownload":
			s.blobs.mu.Lock()
			if b := s.blobs.blobs[str(call["id"])]; b != nil {
				if action == "beginDownload" {
					b.ActiveDownloads++
				} else {
					b.ActiveDownloads = max(0, b.ActiveDownloads-1)
				}
			}
			s.blobs.mu.Unlock()
		case "uploadStatus":
			s.blobs.mu.Lock()
			b := s.blobs.blobs[str(call["id"])]
			status := 200
			var offset int64
			complete := false
			if b == nil || s.blobs.expired(b) {
				status = 404
			} else if !safeToken(b.UploadToken, str(call["token"])) {
				status = 403
			} else {
				offset = b.Written
				complete = b.Complete
			}
			s.blobs.mu.Unlock()
			result = object{"status": status, "offset": offset, "complete": complete}
		case "pairingIssue":
			result = s.pairing.issue(str(call["id"]))
		case "pairingResolve":
			id := s.pairing.resolve(str(call["code"]))
			if id == "" {
				result = nil
			} else {
				result = id
			}
		case "pairingPrune":
			s.pairing.prune()
		default:
			http.Error(w, "unknown action", 400)
			return
		}
		s.blobs.mu.Lock()
		notices := s.blobs.notices
		s.blobs.notices = nil
		s.blobs.mu.Unlock()
		for _, n := range notices {
			for id := range n.Participants {
				if c := s.clients[id]; c != nil {
					c.Socket.send(object{"type": "relay-notice", "message": n.Message})
				}
			}
		}
		jsonReply(w, 200, object{"result": result, "notices": notices})
	})}
	go func() { _ = api.Serve(control) }()
	fmt.Println(string(encode(object{"port": address.(*net.TCPAddr).Port, "control": "http://" + control.Addr().String(), "secret": secret})))
	<-stopping
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return api.Shutdown(ctx)
}
