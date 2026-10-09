package server

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/scrypt"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	c := DefaultConfig()
	c.Host = "127.0.0.1"
	c.Port = 0
	c.AuthToken = ""
	c.AccountsDB = ""
	c.AllowedOrigins = nil
	c.AllowedDevices = nil
	c.Blobs.Dir = filepath.Join(t.TempDir(), "blobs")
	c.PublicDir = t.TempDir()
	return c
}
func startTestServer(t *testing.T, c Config) (*Server, string) {
	t.Helper()
	s, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	addr, e := s.Start()
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if e := s.Stop(ctx); e != nil {
			t.Error(e)
		}
	})
	return s, "http://" + addr.String()
}
func testStore(t *testing.T, c BlobConfig, clock func() int64, online func(string) bool) *blobStore {
	t.Helper()
	c.Dir = filepath.Join(t.TempDir(), "relay")
	s, e := newBlobStore(c, clock, online)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Wipe(); e != nil {
		t.Fatal(e)
	}
	return s
}
func testEnvelope() object {
	return object{"recipient": object{"v": float64(1), "ephemeral": "e", "iv": "i", "ciphertext": "c"}}
}

func TestPairingBoundaryAndUniqueness(t *testing.T) {
	now := int64(1000)
	p := newPairing(func() int64 { return now })
	codes := set{}
	for i := 0; i < 100; i++ {
		id := uuid()
		e := p.Issue(id)
		if codes[e.Code] || p.Resolve(strings.ToLower(e.Code)) != id {
			t.Fatal("pairing code collision or lookup failed")
		}
		codes[e.Code] = true
	}
	e := p.Issue("alice")
	now = e.ExpiresAt - 1
	if p.Issue("alice") != e {
		t.Fatal("early rotation")
	}
	now++
	if p.Resolve(e.Code) != "" {
		t.Fatal("expired code remains valid")
	}
	next := p.Issue("alice")
	if next.Code == e.Code || next.ExpiresAt != now+pairingMaxAgeMS {
		t.Fatal("rotation failed")
	}
}

func TestRegistrationProofBindsChallengeAndFingerprint(t *testing.T) {
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	raw := elliptic.Marshal(key.Curve, key.X, key.Y)
	fingerprint := sha256.Sum256(raw)
	id := base64.RawURLEncoding.EncodeToString(fingerprint[:])
	challenge := "one-socket"
	hash := sha256.Sum256(encode([]string{"evakage/register/1", challenge, id}))
	r, s, e := ecdsa.Sign(rand.Reader, key, hash[:])
	if e != nil {
		t.Fatal(e)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	m := object{"deviceId": id, "identityKey": base64.StdEncoding.EncodeToString(raw), "registrationProof": base64.StdEncoding.EncodeToString(signature)}
	if !verifyRegistration(m, challenge) || verifyRegistration(m, "other-socket") {
		t.Fatal("challenge binding failed")
	}
	m["deviceId"] = token()
	if verifyRegistration(m, challenge) {
		t.Fatal("fingerprint binding failed")
	}
}

func TestConcurrentRelayAdmissionReservesBodies(t *testing.T) {
	c := DefaultConfig().Blobs
	c.MaxStoreBytes = 500
	c.TextReserveBytes = 125
	s := testStore(t, c, nowMS, func(string) bool { return true })
	var admitted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if b, _ := s.Offer("sender", "direct", "file", 128, 100, 1, testEnvelope()); b != nil {
				admitted.Add(1)
			}
		}()
	}
	wg.Wait()
	if admitted.Load() != 1 {
		t.Fatalf("admitted %d uploads into a one-upload budget", admitted.Load())
	}
	if b, msg := s.Offer("sender", "direct", "message", 0, 100, 0, testEnvelope()); b == nil {
		t.Fatal("files consumed text reserve:", msg)
	}
}

func TestChunkUploadRetriesNeverAdvanceCommittedOffset(t *testing.T) {
	s := testStore(t, DefaultConfig().Blobs, nowMS, func(string) bool { return true })
	b, msg := s.Offer("sender", "direct", "file", 228, 100, 2, testEnvelope())
	if b == nil {
		t.Fatal(msg)
	}
	zero := int64(0)
	if status, _, _ := s.Receive(b.ID, b.UploadToken, &zero, bytes.NewReader(make([]byte, 64))); status != 400 {
		t.Fatal(status)
	}
	if b.Written != 0 {
		t.Fatal("partial chunk committed")
	}
	if status, _, _ := s.Receive(b.ID, b.UploadToken, &zero, bytes.NewReader(make([]byte, 128))); status != 204 {
		t.Fatal(status)
	}
	if b.Written != 128 || b.Complete {
		t.Fatal("bad first chunk state")
	}
	if status, _, _ := s.Receive(b.ID, b.UploadToken, &zero, bytes.NewReader(make([]byte, 128))); status != 409 {
		t.Fatal("replayed offset accepted")
	}
	offset := int64(128)
	if status, _, _ := s.Receive(b.ID, b.UploadToken, &offset, bytes.NewReader(make([]byte, 100))); status != 204 || !b.Complete {
		t.Fatal("last chunk failed")
	}
	claim := s.Claim(b.ID, "recipient")
	f, length, status, _, done := s.Download(b.ID, str(claim["downloadToken"]))
	if status != 200 || length != 228 {
		t.Fatal("download failed")
	}
	data, e := io.ReadAll(f)
	done()
	if e != nil || len(data) != 228 {
		t.Fatal("ciphertext length changed")
	}
}

func TestUploadExpiresWhileBodyIsStreaming(t *testing.T) {
	var clock atomic.Int64
	clock.Store(1000)
	c := DefaultConfig().Blobs
	c.MaxAgeMS = 1000
	s := testStore(t, c, clock.Load, func(string) bool { return true })
	b, msg := s.Offer("sender", "direct", "file", 128, 100, 1, testEnvelope())
	if b == nil {
		t.Fatal(msg)
	}
	reader, writer := io.Pipe()
	status := make(chan int, 1)
	go func() {
		defer reader.Close()
		code, _, _ := s.Receive(b.ID, b.UploadToken, nil, reader)
		status <- code
	}()
	if _, e := writer.Write(make([]byte, 64)); e != nil {
		t.Fatal(e)
	}
	clock.Store(2000)
	_, _ = writer.Write(make([]byte, 64))
	_ = writer.Close()
	if code := <-status; code != 410 {
		t.Fatal("expired upload returned", code)
	}
	if len(s.Pending("recipient")) != 0 {
		t.Fatal("expired upload published")
	}
	if _, e := os.Stat(b.Path); !os.IsNotExist(e) {
		t.Fatal("expired body survived")
	}
}

func TestSQLiteCredentialsRemainCompatible(t *testing.T) {
	file := filepath.Join(t.TempDir(), "accounts.sqlite")
	a, e := newAccounts(file, nowMS)
	if e != nil {
		t.Fatal(e)
	}
	salt := "00112233445566778899aabbccddeeff"
	hash, e := scrypt.Key([]byte("correct horse battery staple"), []byte(salt), 16384, 8, 1, 64)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.DB().Exec("INSERT INTO accounts(username,salt,hash) VALUES(?,?,?)", "existing_user", salt, hex.EncodeToString(hash)); e != nil {
		t.Fatal(e)
	}
	if e = a.Close(); e != nil {
		t.Fatal(e)
	}
	a, e = newAccounts(file, nowMS)
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	row, e := a.Get("existing_user")
	if e != nil || row == nil || row.Salt != salt || row.Hash != hex.EncodeToString(hash) {
		t.Fatal("existing credentials changed")
	}
	var version int
	if e = a.DB().QueryRow("PRAGMA user_version").Scan(&version); e != nil || version != 1 {
		t.Fatal("schema changed")
	}
}

func TestShutdownClosesIdleUpgradedConnections(t *testing.T) {
	s, base := startTestServer(t, testConfig(t))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ws, _, e := websocket.Dial(ctx, strings.Replace(base, "http://", "ws://", 1), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ws.CloseNow()
	if e = s.Stop(ctx); e != nil {
		t.Fatal("shutdown held open by an upgraded socket:", e)
	}
}

func TestHealthConfigAndTokenCookie(t *testing.T) {
	c := testConfig(t)
	c.AuthToken = "secret-token"
	s, base := startTestServer(t, c)
	_ = s
	client := http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for path, status := range map[string]int{"/healthz": 200, "/config.json": 401, "/?token=secret-token": 302} {
		response, e := client.Get(base + path)
		if e != nil {
			t.Fatal(e)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != status {
			t.Fatalf("%s: %d", path, response.StatusCode)
		}
		if response.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("missing security header")
		}
		if status == 302 {
			req, _ := http.NewRequest("GET", base+"/config.json", nil)
			for _, cookie := range response.Cookies() {
				req.AddCookie(cookie)
			}
			config, e := client.Do(req)
			if e != nil {
				t.Fatal(e)
			}
			_, _ = io.Copy(io.Discard, config.Body)
			_ = config.Body.Close()
			if config.StatusCode != 200 {
				t.Fatal("cookie authorization failed")
			}
		}
	}
}

func TestAPIOnlyDisablesUIAndRetainsProtocol(t *testing.T) {
	c := testConfig(t)
	c.APIOnly = true
	for _, name := range []string{"index.html", "app.js", "sw.js", "manifest.webmanifest"} {
		if e := os.WriteFile(filepath.Join(c.PublicDir, name), []byte("UI must not be served"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	_, base := startTestServer(t, c)
	for _, path := range []string{"/", "/index.html", "/app.js", "/sw.js", "/manifest.webmanifest", "/share"} {
		response, e := http.Get(base + path)
		if e != nil {
			t.Fatal(e)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != 404 {
			t.Fatalf("%s: expected 404, got %d", path, response.StatusCode)
		}
	}
	for _, path := range []string{"/healthz", "/config.json"} {
		response, e := http.Get(base + path)
		if e != nil {
			t.Fatal(e)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("%s: API is unavailable", path)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ws, _, e := websocket.Dial(ctx, strings.Replace(base, "http://", "ws://", 1), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ws.CloseNow()
	_, message, e := ws.Read(ctx)
	if e != nil || !bytes.Contains(message, []byte("registration-challenge")) {
		t.Fatal("API-only WebSocket did not issue a challenge", e)
	}
}

func TestStartupDoesNotEraseUnrelatedFiles(t *testing.T) {
	c := testConfig(t)
	if e := os.MkdirAll(c.Blobs.Dir, 0700); e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(c.Blobs.Dir, "do-not-delete.txt")
	if e := os.WriteFile(file, []byte("important"), 0600); e != nil {
		t.Fatal(e)
	}
	s, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Stop(context.Background())
	if _, e = s.Start(); e == nil {
		t.Fatal("unrelated files accepted as relay storage")
	}
	if _, e = os.Stat(file); e != nil {
		t.Fatal("unrelated file erased")
	}
}

func TestConcurrentWebSocketTrafficAndHealth(t *testing.T) {
	s, base := startTestServer(t, testConfig(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	errors := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ws, _, e := websocket.Dial(ctx, strings.Replace(base, "http://", "ws://", 1), nil)
			if e != nil {
				errors <- e
				return
			}
			defer ws.CloseNow()
			if e = ws.Write(ctx, websocket.MessageText, encode(object{"type": "register", "deviceId": uuid()})); e != nil {
				errors <- e
				return
			}
			for j := 0; j < 10; j++ {
				if e = ws.Write(ctx, websocket.MessageText, encode(object{"type": "presence-request"})); e != nil {
					errors <- e
					return
				}
				if _, _, e = ws.Read(ctx); e != nil {
					errors <- e
					return
				}
			}
		}()
	}
	for i := 0; i < 10; i++ {
		response, e := http.Get(base + "/healthz")
		if e != nil {
			t.Fatal(e)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("health failed during traffic")
		}
	}
	wg.Wait()
	close(errors)
	for e := range errors {
		t.Error(e)
	}
	if e := s.Stop(ctx); e != nil {
		t.Fatal(e)
	}
}
