package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	backend "github.com/thesteau/evakage/app/server"
)

type Config = backend.Config
type BlobConfig = backend.BlobConfig
type Server = backend.Server
type blobStore = backend.TestStore
type object = map[string]any
type set = map[string]bool

var DefaultConfig = backend.DefaultConfig
var New = backend.New
var newBlobStore = backend.TestNewStore
var newAccounts = backend.TestNewAccounts
var newPairing = backend.TestNewPairing
var verifyRegistration = backend.TestVerifyRegistration

const pairingMaxAgeMS int64 = 259200000

func nowMS() int64        { return time.Now().UnixMilli() }
func str(v any) string    { s, _ := v.(string); return s }
func encode(v any) []byte { b, _ := json.Marshal(v); return b }
func random(n int) []byte {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return b
}
func token() string { return base64.RawURLEncoding.EncodeToString(random(32)) }
func uuid() string {
	b := random(16)
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
