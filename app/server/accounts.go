package server

import (
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/crypto/scrypt"
	_ "modernc.org/sqlite"
)

type account struct {
	Salt, Hash  string
	Preferences object
	Revision    int64
}
type accountSession struct {
	Name, Salt string
	Expires    int64
}
type ticket struct {
	Session, DeviceID string
	Expires           int64
}
type attempt struct {
	Count int
	Until int64
}
type accounts struct {
	mu       sync.Mutex
	db       *sql.DB
	sessions map[string]accountSession
	tickets  map[string]ticket
	attempts map[string]attempt
	revoked  []string
	gate     chan struct{}
	now      func() int64
}

var usernamePattern = regexp.MustCompile(`^[a-z0-9_-]{3,40}$`)

func validatePreferences(v any) object {
	m := obj(v)
	if m == nil {
		return nil
	}
	options := map[string]string{"evakage-theme": "system light dark", "evakage-incoming": "new always auto", "evakage-verified-only": "0 1", "evakage-force-relay": "0 1"}
	for k, v := range m {
		s, ok := v.(string)
		allowed, known := options[k]
		valid := false
		for _, choice := range strings.Fields(allowed) {
			if choice == s {
				valid = true
				break
			}
		}
		if !ok || !known || !valid {
			return nil
		}
	}
	return m
}
func newAccounts(file string, now func() int64) (*accounts, error) {
	a := &accounts{sessions: map[string]accountSession{}, tickets: map[string]ticket{}, attempts: map[string]attempt{}, gate: make(chan struct{}, 4), now: now}
	if file == "" {
		return a, nil
	}
	if e := os.MkdirAll(filepath.Dir(file), 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return nil, e
	}
	_ = f.Close()
	db, e := sql.Open("sqlite", file)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	a.db = db
	fail := func(e error) (*accounts, error) { _ = db.Close(); return nil, e }
	if _, e = db.Exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON;`); e != nil {
		return fail(e)
	}
	var version int
	if e = db.QueryRow("PRAGMA user_version").Scan(&version); e != nil {
		return fail(e)
	}
	if version != 0 && version != 1 {
		return fail(fmt.Errorf("unsupported account database version: %d", version))
	}
	if version == 0 {
		_, e = db.Exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS accounts (
 username TEXT PRIMARY KEY NOT NULL CHECK(length(username) BETWEEN 3 AND 40 AND username NOT GLOB '*[^a-z0-9_-]*'),
 salt TEXT NOT NULL CHECK(length(salt)=32 AND salt NOT GLOB '*[^0-9a-f]*'),
 hash TEXT NOT NULL CHECK(length(hash)=128 AND hash NOT GLOB '*[^0-9a-f]*'),
 preferences TEXT NOT NULL DEFAULT '{}' CHECK(length(preferences)<=4096 AND json_valid(preferences) AND json_type(preferences)='object'),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991)
 ) STRICT; PRAGMA user_version=1; COMMIT;`)
		if e != nil {
			return fail(e)
		}
	}
	return a, nil
}
func (a *accounts) get(name string) (*account, error) {
	var row account
	var p string
	e := a.db.QueryRow("SELECT salt,hash,preferences,revision FROM accounts WHERE username=?", name).Scan(&row.Salt, &row.Hash, &p, &row.Revision)
	if e == sql.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if e = json.Unmarshal([]byte(p), &row.Preferences); e != nil || validatePreferences(row.Preferences) == nil {
		return nil, fmt.Errorf("invalid stored preferences")
	}
	return &row, nil
}
func (a *accounts) revoke(key string) {
	if _, ok := a.sessions[key]; !ok {
		return
	}
	delete(a.sessions, key)
	for t, v := range a.tickets {
		if v.Session == key {
			delete(a.tickets, t)
		}
	}
	a.revoked = append(a.revoked, key)
}
func (a *accounts) pruneLocked() {
	now := a.now()
	for key, s := range a.sessions {
		row, e := a.get(s.Name)
		if e != nil || row == nil || s.Expires <= now || row.Salt != s.Salt {
			a.revoke(key)
		}
	}
	for key, t := range a.tickets {
		if t.Expires <= now {
			delete(a.tickets, key)
		}
	}
}
func (a *accounts) drainRevocations() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := a.revoked
	a.revoked = nil
	return out
}
func (a *accounts) prune() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.db != nil {
		a.pruneLocked()
	}
}
func (a *accounts) name(key string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[key]
	if ok && s.Expires > a.now() {
		return s.Name
	}
	return ""
}
func (a *accounts) owner(key string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[key]
	if ok && s.Expires > a.now() {
		return s.Name + ":" + s.Salt
	}
	return ""
}
func (a *accounts) consume(token, id string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.db != nil {
		a.pruneLocked()
	}
	t, ok := a.tickets[token]
	delete(a.tickets, token)
	if _, live := a.sessions[t.Session]; ok && live && t.DeviceID == id && t.Expires > a.now() {
		return t.Session
	}
	return ""
}
func (a *accounts) close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sessions = map[string]accountSession{}
	a.tickets = map[string]ticket{}
	if a.db != nil {
		return a.db.Close()
	}
	return nil
}
func jsonReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(encode(v))
}
func (a *accounts) handle(w http.ResponseWriter, r *http.Request, host string, secure bool) {
	reply := func(code int, msg string) { jsonReply(w, code, object{"error": msg}) }
	var body object
	if r.Method != "GET" {
		data, e := io.ReadAll(io.LimitReader(r.Body, 4097))
		if e != nil {
			reply(400, "Invalid JSON request.")
			return
		}
		if len(data) > 4096 {
			reply(413, "Request too large.")
			return
		}
		if e = json.Unmarshal(data, &body); e != nil || body == nil {
			reply(400, "Invalid JSON request.")
			return
		}
	}
	select {
	case a.gate <- struct{}{}:
		defer func() { <-a.gate }()
	default:
		reply(429, "Try again later.")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.db == nil {
		reply(503, "Accounts are disabled on this server.")
		return
	}
	a.pruneLocked()
	now := a.now()
	for ip, v := range a.attempts {
		if v.Until <= now {
			delete(a.attempts, ip)
		}
	}
	cookie, _ := r.Cookie("evakage_account")
	raw := ""
	if cookie != nil {
		raw = cookie.Value
	}
	key := digest(raw)
	session, signedIn := a.sessions[key]
	var row *account
	var e error
	if signedIn {
		row, e = a.get(session.Name)
		if e != nil {
			reply(503, "Could not load account.")
			return
		}
	}
	path := r.URL.Path
	if r.Method == "GET" && path == "/account/session" {
		if row == nil {
			jsonReply(w, 200, object{"username": nil})
		} else {
			jsonReply(w, 200, object{"username": session.Name, "preferences": row.Preferences, "revision": row.Revision})
		}
		return
	}
	scheme := "http"
	if secure {
		scheme = "https"
	}
	if r.Header.Get("Origin") != scheme+"://"+host || strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])) != "application/json" {
		reply(403, "Same-origin JSON request required.")
		return
	}
	ip := remoteIP(r)
	limit, exists := a.attempts[ip]
	if !exists {
		if len(a.attempts) >= 4096 {
			reply(429, "Try again later.")
			return
		}
		limit = attempt{Until: now + 60000}
	}
	limit.Count++
	a.attempts[ip] = limit
	if limit.Count > 30 {
		reply(429, "Try again later.")
		return
	}
	setCookie := func(t string, age int) {
		http.SetCookie(w, &http.Cookie{Name: "evakage_account", Value: t, Path: "/account", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: age, Secure: secure})
	}
	if r.Method == "POST" && path == "/account/logout" {
		a.revoke(key)
		setCookie("", -1)
		jsonReply(w, 200, object{"username": nil})
		return
	}
	if r.Method == "DELETE" && path == "/account/delete" {
		if row == nil {
			reply(401, "Sign in first.")
			return
		}
		password := str(body["password"])
		if jsLen(password) < 12 || jsLen(password) > 128 {
			reply(400, "Enter your current password to delete your account.")
			return
		}
		hash, e := scrypt.Key([]byte(password), []byte(row.Salt), 16384, 8, 1, 64)
		if e != nil {
			reply(503, "Could not delete account. Please try again.")
			return
		}
		expected, _ := hex.DecodeString(row.Hash)
		if subtle.ConstantTimeCompare(hash, expected) != 1 {
			reply(401, "Incorrect password. Your account was not deleted.")
			return
		}
		result, e := a.db.Exec("DELETE FROM accounts WHERE username=? AND salt=? AND hash=?", session.Name, row.Salt, row.Hash)
		if e != nil {
			reply(503, "Could not delete account. Please try again.")
			return
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			reply(401, "Account session changed. Sign in again.")
			return
		}
		for k, s := range a.sessions {
			if s.Name == session.Name {
				a.revoke(k)
			}
		}
		setCookie("", -1)
		jsonReply(w, 200, object{"username": nil})
		return
	}
	if r.Method == "POST" && path == "/account/connect" {
		if row == nil {
			reply(401, "Sign in first.")
			return
		}
		id := str(body["deviceId"])
		if !fingerprintPattern.MatchString(id) {
			reply(400, "Invalid device.")
			return
		}
		if len(a.tickets) >= 4096 {
			reply(429, "Try again later.")
			return
		}
		t := token()
		a.tickets[t] = ticket{key, id, now + 30000}
		jsonReply(w, 200, object{"token": t})
		return
	}
	if r.Method == "PUT" && path == "/account/preferences" {
		if row == nil {
			reply(401, "Sign in first.")
			return
		}
		prefs := validatePreferences(body["preferences"])
		if prefs == nil || !integer(body["revision"]) || number(body["revision"]) < 0 {
			reply(400, "Invalid preferences.")
			return
		}
		var revision int64
		e := a.db.QueryRow("UPDATE accounts SET preferences=?,revision=revision+1 WHERE username=? AND revision=? RETURNING revision", string(encode(prefs)), session.Name, number(body["revision"])).Scan(&revision)
		if e == sql.ErrNoRows {
			current, err := a.get(session.Name)
			if err != nil || current == nil {
				reply(503, "Could not save preferences.")
				return
			}
			jsonReply(w, 409, object{"error": "Preferences changed on another device. Load them before saving.", "preferences": current.Preferences, "revision": current.Revision})
			return
		}
		if e != nil {
			reply(503, "Could not save preferences.")
			return
		}
		jsonReply(w, 200, object{"preferences": prefs, "revision": revision})
		return
	}
	if r.Method != "POST" || path != "/account/register" && path != "/account/login" {
		reply(404, "Not found.")
		return
	}
	name := strings.ToLower(strings.TrimSpace(str(body["username"])))
	password := str(body["password"])
	if !usernamePattern.MatchString(name) || jsLen(password) < 12 || jsLen(password) > 128 {
		reply(400, "Use a 3–40 character username and a 12–128 character password.")
		return
	}
	var count int
	if e = a.db.QueryRow("SELECT count(*) FROM accounts").Scan(&count); e != nil {
		reply(503, "Could not load account.")
		return
	}
	if len(a.sessions) >= 4096 || count >= 10000 && path == "/account/register" {
		reply(429, "Try again later.")
		return
	}
	existing, e := a.get(name)
	if e != nil {
		reply(503, "Could not load account.")
		return
	}
	salt := hex.EncodeToString(randomBytes(16))
	if existing != nil {
		salt = existing.Salt
	}
	hash, e := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 64)
	if e != nil {
		reply(503, "Could not authenticate account.")
		return
	}
	if path == "/account/register" {
		result, e := a.db.Exec("INSERT INTO accounts(username,salt,hash) SELECT ?,?,? WHERE (SELECT count(*) FROM accounts)<10000 ON CONFLICT(username) DO NOTHING", name, salt, hex.EncodeToString(hash))
		if e != nil {
			reply(503, "Could not create account.")
			return
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			reply(409, "Choose another username.")
			return
		}
	} else {
		expected := []byte{}
		if existing != nil {
			expected, _ = hex.DecodeString(existing.Hash)
		}
		if existing == nil || subtle.ConstantTimeCompare(hash, expected) != 1 {
			reply(401, "Invalid username or password.")
			return
		}
	}
	a.revoke(key)
	t := token()
	a.sessions[digest(t)] = accountSession{name, salt, now + 30*86400000}
	setCookie(t, 30*86400)
	current, e := a.get(name)
	if e != nil || current == nil {
		reply(503, "Could not load account.")
		return
	}
	jsonReply(w, 200, object{"username": name, "preferences": current.Preferences, "revision": current.Revision})
}
