package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestAccountSessionExpirySurvivesRestart(t *testing.T) {
	var clock atomic.Int64
	clock.Store(1700000000000)
	expires := clock.Load() + 30*86400000
	c := testConfig(t)
	c.Now = clock.Load
	c.AccountsDB = filepath.Join(t.TempDir(), "accounts.sqlite")
	s, base := startTestServer(t, c)
	req, e := http.NewRequest("POST", base+"/account/register", bytes.NewReader(encode(object{
		"username": "persistent_user", "password": "correct horse battery staple",
	})))
	if e != nil {
		t.Fatal(e)
	}
	req.Header.Set("Origin", base)
	req.Header.Set("Content-Type", "application/json")
	response, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 200 || len(response.Cookies()) != 1 {
		t.Fatal("registration failed:", response.StatusCode)
	}
	cookie := response.Cookies()[0]
	checkSession := func(base string, want any) {
		t.Helper()
		req, e := http.NewRequest("GET", base+"/account/session", nil)
		if e != nil {
			t.Fatal(e)
		}
		req.AddCookie(cookie)
		response, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		var reply object
		if e := json.NewDecoder(response.Body).Decode(&reply); e != nil {
			t.Fatal(e)
		}
		if response.StatusCode != 200 || reply["username"] != want {
			t.Fatalf("session status=%d reply=%v, want username=%v", response.StatusCode, reply, want)
		}
	}
	stop := func(s *Server) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if e := s.Stop(ctx); e != nil {
			t.Fatal(e)
		}
	}
	checkSession(base, "persistent_user")
	stop(s)
	clock.Store(expires - 1)
	s, base = startTestServer(t, c)
	checkSession(base, "persistent_user")
	stop(s)
	clock.Store(expires)
	s, base = startTestServer(t, c)
	checkSession(base, nil)
	stop(s)
	a, e := newAccounts(c.AccountsDB, clock.Load)
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	var count int
	if e = a.DB().QueryRow("SELECT count(*) FROM account_sessions").Scan(&count); e != nil || count != 0 {
		t.Fatal("expired sessions remain in the database:", count, e)
	}
	if row, e := a.Get("persistent_user"); e != nil || row == nil {
		t.Fatal("session expiry removed the account:", e)
	}
}
