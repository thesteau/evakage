// Package server implements Evakage's browser protocol. Content stays encrypted;
// only account credentials and preferences are durable.
package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type object = map[string]any
type set map[string]bool

func newSet(ids ...string) set {
	s := set{}
	for _, id := range ids {
		s[id] = true
	}
	return s
}
func keys(s set) []string {
	out := []string{}
	for k := range s {
		out = append(out, k)
	}
	sortStrings(out)
	return out
}
func str(v any) string   { s, _ := v.(string); return s }
func obj(v any) object   { m, _ := v.(map[string]any); return m }
func number(v any) int64 { f, _ := v.(float64); return int64(f) }
func integer(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f) && math.Abs(f) <= 9007199254740991
}
func jsLen(s string) int         { return len(utf16.Encode([]rune(s))) }
func optional(v any, n int) bool { s, ok := v.(string); return v == nil || ok && jsLen(s) <= n }
func required(v any, n int) bool { s, ok := v.(string); return ok && len(s) > 0 && jsLen(s) <= n }
func nowMS() int64               { return time.Now().UnixMilli() }
func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return b
}
func token() string { return base64.RawURLEncoding.EncodeToString(randomBytes(32)) }
func uuid() string {
	b := randomBytes(16)
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func encode(v any) []byte    { b, _ := json.Marshal(v); return b }
func env(s, fallback string) string {
	if v := os.Getenv(s); v != "" {
		return v
	}
	return fallback
}
func envInt(s string, n int64) int64 {
	v, e := strconv.ParseInt(env(s, strconv.FormatInt(n, 10)), 10, 64)
	if e != nil {
		return -1
	}
	return v
}

// envCount is envInt for int-sized settings, parsed straight to int so no
// value is narrowed by a conversion.
func envCount(s string, n int) int {
	v, e := strconv.Atoi(env(s, strconv.Itoa(n)))
	if e != nil {
		return -1
	}
	return v
}
func envRoomCap() int {
	n, e := strconv.ParseFloat(env("ROOM_MAX_MEMBERS", "20"), 64)
	if e != nil || math.IsNaN(n) || n == 0 {
		return 20
	}
	return int(max(2, min(64, math.Floor(n))))
}
func truthy(s string) bool {
	switch strings.ToLower(s) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
func split(s string) []string {
	out := []string{}
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}
func clean(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > 64 {
		s = string(r[:64])
	}
	if s == "" {
		s = "Unnamed device"
	}
	return s
}

type Limits struct {
	MessagesPerSecond, MessageBurst, SignalsPerSecond, SignalBurst float64
	MaxInvalidMessages, ConnectionsPerIP, RegistrationsPerMinute   int
}
type BlobConfig struct {
	Dir                                                                                               string
	MaxBlobBytes, MaxStoreBytes, TextReserveBytes, MaxConversationFileBytes, MaxConversationTextBytes int64
	MaxBlobsPerDevice, MaxMessagesPerDevice                                                           int
	IdleGraceMS, SoloMaxMS, MaxAgeMS, SweepEveryMS                                                    int64
}
type Config struct {
	Host                                                   string
	Port                                                   int
	PublicDir, AuthToken, AccountsDB                       string
	TrustProxy                                             bool
	AllowedOrigins, AllowedDevices                         []string
	MaxDevices, MaxRooms, MaxRoomMembers, MaxRecentDevices int
	RecentWindowMS, RejoinGraceMS                          int64
	ICE                                                    []any
	Limits                                                 Limits
	Blobs                                                  BlobConfig
	Now                                                    func() int64
}

func DefaultConfig() Config {
	var ice []any
	_ = json.Unmarshal([]byte(env("ICE_SERVERS_JSON", "[]")), &ice)
	if ice == nil {
		ice = []any{}
	}
	return Config{Host: env("HOST", "0.0.0.0"), Port: envCount("PORT", 3000), PublicDir: env("PUBLIC_DIR", filepath.Join("dist", "app", "public")), AuthToken: os.Getenv("AUTH_TOKEN"), AccountsDB: os.Getenv("ACCOUNTS_DB"), TrustProxy: truthy(os.Getenv("TRUST_PROXY")), AllowedOrigins: split(os.Getenv("ALLOWED_ORIGINS")), AllowedDevices: split(os.Getenv("DEVICE_ALLOWLIST")), MaxDevices: envCount("MAX_DEVICES", 200), MaxRooms: envCount("MAX_ROOMS", 50), MaxRoomMembers: envRoomCap(), MaxRecentDevices: 10000, RecentWindowMS: envInt("BLOB_SOLO_MAX_MS", 10800000), RejoinGraceMS: 10000, ICE: ice, Now: nowMS,
		Limits: Limits{40, 90, 60, 140, 20, 24, 40},
		Blobs:  BlobConfig{Dir: env("BLOB_DIR", filepath.Join(os.TempDir(), "evakage-blobs")), MaxBlobBytes: envInt("MAX_FILE_BYTES", 512<<20), MaxStoreBytes: envInt("BLOB_STORE_BYTES", 4<<30), TextReserveBytes: envInt("BLOB_TEXT_RESERVE_BYTES", 1<<30), MaxConversationFileBytes: envInt("BLOB_CHAT_FILE_BYTES", 50<<30), MaxConversationTextBytes: envInt("BLOB_CHAT_TEXT_BYTES", 1<<30), MaxBlobsPerDevice: envCount("BLOB_PER_DEVICE", 32), MaxMessagesPerDevice: envCount("BLOB_MESSAGES_PER_DEVICE", 2000), IdleGraceMS: envInt("BLOB_IDLE_GRACE_MS", 900000), SoloMaxMS: envInt("BLOB_SOLO_MAX_MS", 10800000), MaxAgeMS: envInt("BLOB_MAX_AGE_MS", 259200000), SweepEveryMS: envInt("BLOB_SWEEP_MS", 60000)}}
}

type bucket struct {
	rate, capacity, tokens float64
	updated                int64
}

func newBucket(rate, cap float64) *bucket { return &bucket{rate, cap, cap, nowMS()} }
func (b *bucket) take() bool {
	now := nowMS()
	b.tokens = math.Min(b.capacity, b.tokens+float64(now-b.updated)/1000*b.rate)
	b.updated = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
