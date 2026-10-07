package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type blob struct {
	ID, Kind, SenderID, Conv, UploadToken, Dir, Path, EnvelopePath   string
	Bytes, ChunkSize, TotalChunks, EnvelopeBytes, Written, CreatedAt int64
	IdleSince, SoloSince                                             *int64
	Recipients, Participants, Released                               set
	DownloadTokens                                                   map[string]string
	Complete, Uploading                                              bool
	ActiveDownloads                                                  int
}
type blobStore struct {
	mu      sync.Mutex
	config  BlobConfig
	blobs   map[string]*blob
	secret  []byte
	now     func() int64
	online  func(string) bool
	warned  set
	notices []relayNotice
}
type relayNotice struct {
	Participants set
	Message      string
}

func newBlobStore(c BlobConfig, now func() int64, online func(string) bool) (*blobStore, error) {
	for _, n := range []int64{c.MaxBlobBytes, c.MaxStoreBytes, c.TextReserveBytes, c.MaxConversationFileBytes, c.MaxConversationTextBytes, c.MaxAgeMS, c.IdleGraceMS, c.SoloMaxMS, c.SweepEveryMS} {
		if n > 9007199254740991 {
			return nil, fmt.Errorf("blob configuration exceeds the protocol integer range")
		}
	}
	if c.MaxBlobBytes < 1 || c.MaxStoreBytes < 1 || c.TextReserveBytes < 1 || c.MaxConversationFileBytes < 1 || c.MaxConversationTextBytes < 1 || c.MaxBlobsPerDevice < 1 || c.MaxMessagesPerDevice < 1 || c.MaxAgeMS < 1 || c.IdleGraceMS < 0 || c.SoloMaxMS < 0 || c.SweepEveryMS < 1 {
		return nil, fmt.Errorf("invalid blob configuration")
	}
	dir, e := filepath.Abs(c.Dir)
	if e != nil {
		return nil, e
	}
	if dir == filepath.VolumeName(dir)+string(filepath.Separator) || dir == "." {
		return nil, fmt.Errorf("blob directory cannot be a filesystem root")
	}
	c.Dir = dir
	return &blobStore{config: c, blobs: map[string]*blob{}, secret: randomBytes(32), now: now, online: online, warned: set{}}, nil
}
func (s *blobStore) diskName(v string) string {
	h := hmac.New(sha256.New, s.secret)
	_, _ = h.Write([]byte(v))
	return hex.EncodeToString(h.Sum(nil))[:32]
}
func (s *blobStore) conversation(conv string, p set) string {
	if strings.HasPrefix(conv, "room:") {
		return "r-" + s.diskName(conv)
	}
	return "d-" + s.diskName(strings.Join(keys(p), "|"))
}

// Only owned relay files are erased. Refuse symlinks and unrelated entries so a
// mistaken BLOB_DIR cannot turn startup cleanup into an arbitrary directory wipe.
func (s *blobStore) wipe() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := os.MkdirAll(s.config.Dir, 0700); e != nil {
		return e
	}
	entries, e := os.ReadDir(s.config.Dir)
	if e != nil {
		return e
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || !(strings.HasPrefix(name, "r-") || strings.HasPrefix(name, "d-")) || len(name) != 34 {
			return fmt.Errorf("unexpected entry in blob directory: %s", name)
		}
		children, e := os.ReadDir(filepath.Join(s.config.Dir, name))
		if e != nil {
			return e
		}
		for _, child := range children {
			base := strings.TrimSuffix(strings.TrimSuffix(child.Name(), ".env.json"), ".bin")
			if child.Type()&os.ModeSymlink != 0 || child.IsDir() || !uuidPattern.MatchString(base) || !(strings.HasSuffix(child.Name(), ".env.json") || strings.HasSuffix(child.Name(), ".bin")) {
				return fmt.Errorf("unexpected relay file: %s", child.Name())
			}
		}
	}
	for _, entry := range entries {
		if e = os.RemoveAll(filepath.Join(s.config.Dir, entry.Name())); e != nil {
			return e
		}
	}
	s.blobs = map[string]*blob{}
	return nil
}
func (s *blobStore) expires(b *blob) int64 {
	age := s.config.MaxAgeMS
	if len(b.Participants) == 1 {
		age = min(age, 259200000)
	}
	deadline := b.CreatedAt + age
	if b.IdleSince != nil {
		grace := s.config.IdleGraceMS
		if len(b.Participants) == 1 {
			grace = 86400000
		}
		deadline = min(deadline, *b.IdleSince+grace)
	}
	if b.SoloSince != nil && len(b.Participants) > 1 {
		deadline = min(deadline, *b.SoloSince+s.config.SoloMaxMS)
	}
	return deadline
}
func (s *blobStore) expired(b *blob) bool { return s.now() >= s.expires(b) }
func (s *blobStore) assess(b *blob, now int64) {
	if len(b.Participants) == 1 && s.expired(b) {
		return
	}
	present := 0
	for id := range b.Participants {
		if s.online(id) {
			present++
		}
	}
	if present == 0 {
		if b.IdleSince == nil {
			n := now
			b.IdleSince = &n
		}
		b.SoloSince = nil
		return
	}
	b.IdleSince = nil
	if !strings.HasPrefix(b.Conv, "room:") && present == 1 {
		if b.SoloSince == nil {
			n := now
			b.SoloSince = &n
		}
	} else {
		b.SoloSince = nil
	}
}
func (s *blobStore) refresh() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.blobs {
		s.assess(b, s.now())
	}
}
func (s *blobStore) removeLocked(id string) bool {
	b := s.blobs[id]
	if b == nil {
		return false
	}
	delete(s.blobs, id)
	_ = os.Remove(b.Path)
	_ = os.Remove(b.EnvelopePath)
	_ = os.Remove(b.Dir)
	any := false
	for _, other := range s.blobs {
		if other.Dir == b.Dir && other.Kind == b.Kind {
			any = true
		}
	}
	if !any {
		delete(s.warned, b.Dir+":"+b.Kind)
	}
	return true
}
func (s *blobStore) remove(id string) { s.mu.Lock(); defer s.mu.Unlock(); s.removeLocked(id) }
func (s *blobStore) usage(kind, dir string) int64 {
	var n int64
	for _, b := range s.blobs {
		if b.Kind == kind && (dir == "" || b.Dir == dir) {
			n += b.Bytes + b.EnvelopeBytes
		}
	}
	return n
}
func (s *blobStore) makeSpace(kind string, incoming, limit int64, dir string, check bool) bool {
	if incoming > limit {
		return false
	}
	candidates := []*blob{}
	var reclaim int64
	for _, b := range s.blobs {
		if b.Kind == kind && (dir == "" || b.Dir == dir) && b.Complete && !b.Uploading && b.ActiveDownloads == 0 {
			candidates = append(candidates, b)
			reclaim += b.Bytes + b.EnvelopeBytes
		}
	}
	if s.usage(kind, dir)+incoming-reclaim > limit {
		return false
	}
	if check {
		return true
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if s.expired(a) != s.expired(b) {
			return s.expired(a)
		}
		return a.CreatedAt < b.CreatedAt
	})
	affected := set{}
	for _, b := range candidates {
		if s.usage(kind, dir)+incoming <= limit {
			break
		}
		for id := range b.Participants {
			affected[id] = true
		}
		s.removeLocked(b.ID)
	}
	if len(affected) > 0 {
		s.notices = append(s.notices, relayNotice{affected, "Older pending items were removed to make space in temporary delivery. Save files you need to keep."})
	}
	return true
}
func (s *blobStore) offer(sender, conv, kind string, bytes, chunkSize, chunks int64, envelopes object) (*blob, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind == "" {
		kind = "file"
	}
	message := kind == "message"
	if message {
		if bytes != 0 || chunks != 0 {
			return nil, "A relayed message carries no body."
		}
	} else {
		if bytes < 0 || chunks > 9007199254740991/28 || bytes > s.config.MaxBlobBytes+chunks*28 {
			return nil, "That file is larger than this server accepts."
		}
		if chunkSize <= 0 || chunks != (max(int64(0), bytes-chunks*28)+chunkSize-1)/chunkSize {
			return nil, "Chunk count does not match the declared size."
		}
	}
	owned := 0
	for _, b := range s.blobs {
		if b.SenderID == sender && b.Kind == kind {
			owned++
		}
	}
	cap := s.config.MaxBlobsPerDevice
	if message {
		cap = s.config.MaxMessagesPerDevice
	}
	if owned >= cap {
		if message {
			return nil, fmt.Sprintf("This device already has %d messages waiting on the server.", cap)
		}
		return nil, fmt.Sprintf("Each device may buffer %d transfers at a time.", cap)
	}
	if len(envelopes) == 0 {
		return nil, "No recipients."
	}
	hashed := object{}
	recipients := set{}
	participants := newSet(sender)
	for id, v := range envelopes {
		hashed[s.diskName(id)] = v
		recipients[id] = true
		participants[id] = true
	}
	data := encode(hashed)
	dir := filepath.Join(s.config.Dir, s.conversation(conv, participants))
	incoming := bytes + int64(len(data))
	chatLimit := s.config.MaxConversationFileBytes
	reserve := min(s.config.TextReserveBytes, s.config.MaxStoreBytes/4)
	globalLimit := s.config.MaxStoreBytes - reserve
	if message {
		chatLimit = s.config.MaxConversationTextBytes
		globalLimit = reserve
	}
	if incoming > chatLimit || incoming > globalLimit {
		return nil, "This item exceeds the temporary relay capacity. Use a smaller file or message."
	}
	if !s.makeSpace(kind, incoming, chatLimit, dir, true) || !s.makeSpace(kind, incoming, globalLimit, "", true) {
		return nil, "The temporary relay is busy with active transfers. Try again shortly."
	}
	s.makeSpace(kind, incoming, chatLimit, dir, false)
	s.makeSpace(kind, incoming, globalLimit, "", false)
	id := uuid()
	b := &blob{ID: id, Kind: kind, SenderID: sender, Conv: conv, Bytes: bytes, ChunkSize: chunkSize, TotalChunks: chunks, Recipients: recipients, Participants: participants, Released: set{}, UploadToken: token(), DownloadTokens: map[string]string{}, Dir: dir, Path: filepath.Join(dir, id+".bin"), EnvelopePath: filepath.Join(dir, id+".env.json"), EnvelopeBytes: int64(len(data)), Complete: message, CreatedAt: s.now()}
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, "The server could not store that."
	}
	if e := os.WriteFile(b.EnvelopePath, data, 0600); e != nil {
		return nil, "The server could not store that."
	}
	s.assess(b, b.CreatedAt)
	s.blobs[id] = b
	warning := dir + ":" + kind
	near := s.usage(kind, dir)*5 >= chatLimit*4 || s.usage(kind, "")*5 >= globalLimit*4
	if near && !s.warned[warning] {
		s.warned[warning] = true
		label := "file"
		if message {
			label = "message"
		}
		s.notices = append(s.notices, relayNotice{participants, "Temporary " + label + " delivery capacity is nearly full. Older pending items may be removed; save files you need to keep."})
	} else if !near {
		delete(s.warned, warning)
	}
	return b, ""
}
func safeToken(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(digest(a)), []byte(digest(b))) == 1
}
func (s *blobStore) receive(id, t string, offset *int64, reader io.Reader) (int, string, *blob) {
	s.mu.Lock()
	b := s.blobs[id]
	if b == nil || s.expired(b) || b.Kind != "file" {
		s.mu.Unlock()
		return 404, "No such transfer.", nil
	}
	if !safeToken(t, b.UploadToken) {
		s.mu.Unlock()
		return 403, "Bad upload token.", nil
	}
	if b.Uploading || b.Complete || offset == nil && b.Written > 0 || offset != nil && (*offset != b.Written || *offset < 0) {
		s.mu.Unlock()
		return 409, "Upload offset conflict.", nil
	}
	start := int64(0)
	length := b.Bytes
	if offset != nil {
		start = *offset
		length = min(b.ChunkSize+28, b.Bytes-start)
		if start%(b.ChunkSize+28) != 0 {
			s.mu.Unlock()
			return 400, "Offset must be a chunk boundary.", nil
		}
	}
	b.Uploading = true
	s.mu.Unlock()
	status, msg := 204, ""
	var written int64
	flags := os.O_CREATE | os.O_WRONLY
	if start == 0 {
		flags |= os.O_TRUNC
	}
	f, e := os.OpenFile(b.Path, flags, 0600)
	if e != nil {
		status, msg = 500, "Could not buffer that transfer."
	} else {
		if offset != nil {
			data, err := io.ReadAll(io.LimitReader(reader, length+1))
			if err != nil || int64(len(data)) < length {
				status, msg = 400, "Incomplete ciphertext chunk."
			} else if int64(len(data)) > length {
				status, msg = 413, "Chunk exceeded declared length."
			} else {
				n, err := f.WriteAt(data, start)
				written = int64(n)
				if err != nil {
					status, msg = 500, "Could not buffer that transfer."
				}
			}
		} else {
			buf := make([]byte, 64<<10)
			for {
				n, err := reader.Read(buf)
				if n > 0 {
					s.mu.Lock()
					expired := s.blobs[id] != b || s.expired(b)
					s.mu.Unlock()
					if expired {
						status, msg = 410, "That transfer has expired."
						break
					}
					if written+int64(n) > length {
						status, msg = 413, "Upload exceeded the declared length."
						break
					}
					k, err := f.Write(buf[:n])
					written += int64(k)
					if err != nil {
						status, msg = 500, "Could not buffer that transfer."
						break
					}
				}
				if err == io.EOF {
					break
				}
				if err != nil {
					status, msg = 400, "Upload interrupted."
					break
				}
			}
			if status == 204 && written != length {
				status, msg = 400, "Upload length did not match the declared length."
			}
		}
		if err := f.Close(); err != nil && status == 204 {
			status, msg = 500, "Could not buffer that transfer."
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b.Uploading = false
	if s.blobs[id] != b {
		_ = os.Remove(b.Path)
		_ = os.Remove(b.EnvelopePath)
		_ = os.Remove(b.Dir)
	}
	if s.blobs[id] != b || s.expired(b) {
		status, msg = 410, "That transfer has expired."
	}
	if status != 204 {
		if offset == nil {
			s.removeLocked(id)
		}
		return status, msg, nil
	}
	b.Written += written
	b.Complete = b.Written == b.Bytes
	if b.Complete {
		return 204, "", b
	}
	return 204, "", nil
}
func (s *blobStore) envelope(b *blob, id string) any {
	data, e := os.ReadFile(b.EnvelopePath)
	if e != nil {
		return nil
	}
	var m object
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	return m[s.diskName(id)]
}
func (s *blobStore) describeLocked(b *blob, id string) object {
	if s.blobs[b.ID] != b || s.expired(b) {
		return nil
	}
	return object{"blobId": b.ID, "kind": b.Kind, "from": b.SenderID, "conv": b.Conv, "bytes": b.Bytes, "chunkSize": b.ChunkSize, "totalChunks": b.TotalChunks, "envelope": s.envelope(b, id), "createdAt": b.CreatedAt, "expiresAt": s.expires(b)}
}
func (s *blobStore) pending(id string) []object {
	s.mu.Lock()
	defer s.mu.Unlock()
	ready := []*blob{}
	for _, b := range s.blobs {
		if !s.expired(b) && b.Complete && b.Recipients[id] && !b.Released[id] {
			ready = append(ready, b)
		}
	}
	sort.Slice(ready, func(i, j int) bool { return ready[i].CreatedAt < ready[j].CreatedAt })
	items := []object{}
	for _, b := range ready {
		if item := s.describeLocked(b, id); item != nil {
			items = append(items, item)
		}
	}
	return items
}
func (s *blobStore) claim(id, device string) object {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.blobs[id]
	if b == nil || s.expired(b) {
		return object{"error": "That transfer is no longer available."}
	}
	if !b.Participants[device] {
		return object{"error": "That transfer is not addressed to this device."}
	}
	if !b.Complete {
		return object{"error": "That transfer is still uploading."}
	}
	t := token()
	b.DownloadTokens[t] = device
	return object{"type": "blob-claimed", "blobId": id, "downloadToken": t, "envelope": s.envelope(b, device), "bytes": b.Bytes}
}
func (s *blobStore) download(id, t string) (*os.File, int64, int, string, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.blobs[id]
	if b == nil || s.expired(b) || !b.Complete || b.Kind != "file" {
		return nil, 0, 404, "No such transfer.", nil
	}
	if _, ok := b.DownloadTokens[t]; !ok {
		return nil, 0, 403, "Bad download token.", nil
	}
	f, e := os.Open(b.Path)
	if e != nil {
		return nil, 0, 404, "No such transfer.", nil
	}
	b.ActiveDownloads++
	return f, b.Written, 200, "", func() {
		_ = f.Close()
		s.mu.Lock()
		defer s.mu.Unlock()
		b.ActiveDownloads--
		if s.blobs[id] != b {
			_ = os.Remove(b.Path)
			_ = os.Remove(b.Dir)
		}
	}
}
func (s *blobStore) release(id, device string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.blobs[id]
	if b == nil || !b.Recipients[device] {
		return
	}
	if len(b.Participants) == 1 && !s.expired(b) {
		return
	}
	b.Released[device] = true
	for id := range b.Recipients {
		if !b.Released[id] {
			return
		}
	}
	s.removeLocked(b.ID)
}
func (s *blobStore) revokeDevice(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.blobs {
		if !b.Participants[id] {
			continue
		}
		if b.Conv == "direct" || b.SenderID == id {
			s.removeLocked(b.ID)
		} else {
			delete(b.Participants, id)
			delete(b.Recipients, id)
			for t, owner := range b.DownloadTokens {
				if owner == id {
					delete(b.DownloadTokens, t)
				}
			}
		}
	}
}
func (s *blobStore) revokeConversation(conv string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.blobs {
		if b.Conv == conv {
			s.removeLocked(b.ID)
		}
	}
}
func (s *blobStore) sweep() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	purged := []string{}
	for _, b := range s.blobs {
		s.assess(b, s.now())
		if s.expired(b) {
			s.removeLocked(b.ID)
			purged = append(purged, b.ID)
		}
	}
	entries, _ := os.ReadDir(s.config.Dir)
	for _, e := range entries {
		if e.IsDir() {
			_ = os.Remove(filepath.Join(s.config.Dir, e.Name()))
		}
	}
	return purged
}
func (s *blobStore) stats() object {
	s.mu.Lock()
	defer s.mu.Unlock()
	files, messages := 0, 0
	var bytes int64
	for _, b := range s.blobs {
		if b.Kind == "file" {
			files++
		} else {
			messages++
		}
		bytes += b.Written + b.EnvelopeBytes
	}
	return object{"count": len(s.blobs), "files": files, "messages": messages, "bytes": bytes, "reservedFileBytes": s.usage("file", ""), "reservedTextBytes": s.usage("message", "")}
}

// SweepDirectory supports host-side maintenance without starting a server.
func SweepDirectory(dir string, maxAgeMS int64) (object, error) {
	removed, kept, dirs := 0, 0, 0
	cutoff := nowMS() - maxAgeMS
	entries, e := os.ReadDir(dir)
	if os.IsNotExist(e) {
		return object{"removed": 0, "kept": 0, "directories": 0}, nil
	}
	if e != nil {
		return nil, e
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		children, e := os.ReadDir(path)
		if e != nil {
			return nil, e
		}
		for _, child := range children {
			if child.IsDir() || child.Type()&os.ModeSymlink != 0 {
				continue
			}
			info, e := child.Info()
			if e != nil {
				return nil, e
			}
			if info.ModTime().UnixMilli() <= cutoff {
				if e = os.Remove(filepath.Join(path, child.Name())); e != nil {
					return nil, e
				}
				removed++
			} else {
				kept++
			}
		}
		if os.Remove(path) == nil {
			dirs++
		}
	}
	return object{"removed": removed, "kept": kept, "directories": dirs}, nil
}
