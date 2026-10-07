package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"math/big"
	"regexp"
	"sort"
	"strings"
)

var devicePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
var fingerprintPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func sortStrings(s []string)               { sort.Strings(s) }
func matches(p *regexp.Regexp, v any) bool { s, ok := v.(string); return ok && p.MatchString(s) }
func boolean(v any) bool                   { _, ok := v.(bool); return ok }
func validSignal(v any) bool {
	d := obj(v)
	if d == nil {
		return false
	}
	switch str(d["type"]) {
	case "knock":
		return true
	case "offer", "answer":
		s := obj(d["sdp"])
		return s != nil && s["type"] == d["type"] && required(s["sdp"], 96<<10) && len(str(s["sdp"])) <= 96<<10
	case "ice":
		c := obj(d["candidate"])
		if c == nil {
			return false
		}
		_, ok := c["candidate"].(string)
		i := c["sdpMLineIndex"]
		return ok && optional(c["candidate"], 1024) && optional(c["sdpMid"], 64) && optional(c["usernameFragment"], 256) && (i == nil || integer(i) && number(i) >= 0 && number(i) < 16)
	}
	return false
}
func validEnvelopes(v any, kind string) bool {
	m := obj(v)
	if len(m) == 0 || len(m) > 64 {
		return false
	}
	max := 4096
	if kind == "message" {
		max = 64 << 10
	}
	for id, v := range m {
		b := obj(v)
		if !devicePattern.MatchString(id) || b == nil || b["v"] != float64(1) {
			return false
		}
		for _, k := range []string{"ephemeral", "iv", "ciphertext"} {
			if !required(b[k], max) {
				return false
			}
		}
	}
	return true
}
func validAccess(v any) bool {
	s, ok := v.(string)
	return ok && (s == "private" || s == "protected" || s == "public")
}
func validMessage(m object) bool {
	switch str(m["type"]) {
	case "register":
		return matches(devicePattern, m["deviceId"]) && optional(m["name"], 512) && optional(m["platform"], 512) && optional(m["browser"], 512) && (m["discoverable"] == nil || boolean(m["discoverable"])) && optional(m["registrationProof"], 128) && optional(m["identityKey"], 256) && optional(m["sealKey"], 256) && optional(m["sealKeySignature"], 256)
	case "set-discoverable":
		return boolean(m["enabled"])
	case "presence-request", "rooms-request", "blobs-request", "self-clear":
		return true
	case "resolve-code":
		return optional(m["requestId"], 128) && optional(m["code"], 32)
	case "pair-device":
		return optional(m["requestId"], 128) && optional(m["code"], 32) && optional(m["targetId"], 128)
	case "unpair-device":
		return matches(devicePattern, m["deviceId"])
	case "account-connect":
		return matches(fingerprintPattern, m["token"])
	case "create-room":
		return optional(m["name"], 512) && (m["access"] == nil || validAccess(m["access"]))
	case "room-approve":
		return matches(uuidPattern, m["roomId"]) && matches(devicePattern, m["deviceId"]) && boolean(m["approve"])
	case "room-access":
		return matches(uuidPattern, m["roomId"]) && validAccess(m["access"])
	case "join-room":
		return (m["roomId"] == nil || matches(uuidPattern, m["roomId"])) && optional(m["code"], 32) && optional(m["name"], 512) && (m["recreate"] == nil || boolean(m["recreate"])) && (m["roomId"] != nil || strings.TrimSpace(str(m["code"])) != "")
	case "leave-room":
		return matches(uuidPattern, m["roomId"])
	case "signal":
		return matches(devicePattern, m["to"]) && validSignal(m["data"])
	case "blob-offer":
		kind := str(m["kind"])
		conv := str(m["conv"])
		return optional(m["requestId"], 64) && (m["kind"] == nil || kind == "file" || kind == "message") && (conv == "direct" || strings.HasPrefix(conv, "room:") && uuidPattern.MatchString(strings.TrimPrefix(conv, "room:"))) && integer(m["bytes"]) && number(m["bytes"]) >= 0 && integer(m["chunkSize"]) && number(m["chunkSize"]) > 0 && number(m["chunkSize"]) <= 1<<20 && integer(m["totalChunks"]) && number(m["totalChunks"]) >= 0 && validEnvelopes(m["envelopes"], kind)
	case "blob-claim", "blob-release", "blob-cancel":
		return matches(uuidPattern, m["blobId"])
	case "lookup-devices":
		ids, ok := m["deviceIds"].([]any)
		if !ok || len(ids) == 0 || len(ids) > 200 || !optional(m["requestId"], 64) {
			return false
		}
		for _, id := range ids {
			if !matches(devicePattern, id) {
				return false
			}
		}
		return true
	}
	return false
}
func verifyRegistration(m object, challenge string) bool {
	raw, e := base64.StdEncoding.DecodeString(str(m["identityKey"]))
	if e != nil || len(raw) != 65 || raw[0] != 4 {
		return false
	}
	sig, e := base64.StdEncoding.DecodeString(str(m["registrationProof"]))
	if e != nil || len(sig) != 64 {
		return false
	}
	hash := sha256.Sum256(raw)
	if base64.RawURLEncoding.EncodeToString(hash[:]) != str(m["deviceId"]) {
		return false
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), raw)
	if x == nil {
		return false
	}
	h := sha256.Sum256(encode([]string{"evakage/register/1", challenge, str(m["deviceId"])}))
	return ecdsa.Verify(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

const pairingMaxAgeMS int64 = 259200000
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

type pairingEntry struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
}
type pairingCodes struct {
	records map[string]pairingEntry
	owners  map[string]string
	now     func() int64
}

func newPairing(now func() int64) *pairingCodes {
	return &pairingCodes{map[string]pairingEntry{}, map[string]string{}, now}
}
func invitation() string {
	b := randomBytes(8)
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b[:4]) + "-" + string(b[4:])
}
func (p *pairingCodes) forget(id string) { delete(p.owners, p.records[id].Code); delete(p.records, id) }
func (p *pairingCodes) issue(id string) pairingEntry {
	if e, ok := p.records[id]; ok && p.now() < e.ExpiresAt {
		return e
	}
	p.forget(id)
	c := invitation()
	for p.owners[c] != "" {
		c = invitation()
	}
	e := pairingEntry{c, p.now() + pairingMaxAgeMS}
	p.records[id] = e
	p.owners[c] = id
	return e
}
func (p *pairingCodes) resolve(code string) string {
	id := p.owners[strings.ToUpper(strings.TrimSpace(code))]
	if id != "" && p.now() >= p.records[id].ExpiresAt {
		p.forget(id)
		return ""
	}
	return id
}
func (p *pairingCodes) prune() {
	for id, e := range p.records {
		if p.now() >= e.ExpiresAt {
			p.forget(id)
		}
	}
}
