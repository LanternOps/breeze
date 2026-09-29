package storagesession

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeWriteBackend is an S3-like store plus the write-session control plane
// for one agent and one session. Object URLs are /put?k=<key>,
// /part?k=<key>&u=<uploadId>&n=<part> and /obj?k=<key>.
type fakeWriteBackend struct {
	t       *testing.T
	storage *httptest.Server
	control *httptest.Server

	mu          sync.Mutex
	snapshotID  string
	objects     map[string][]byte
	uploads     map[string]map[int][]byte // uploadId -> part -> bytes
	uploadKeys  map[string]string         // uploadId -> key
	nextUpload  int
	conditional bool
	sse         map[string]string // headers every PUT carries
	storageReqs []*http.Request
	calls       []writeCall
	listPage    int
	urlTTL      time.Duration
	// createEncryption, when set, is returned by multipart:create as
	// appliedEncryption.
	createEncryption map[string]any
	// createEncryptionNull answers appliedEncryption: null.
	createEncryptionNull bool
	// clockOffset is how far the control plane's clock is ahead of the
	// device's; sendExpiresIn adds expiresIn (whole seconds) to issued URLs.
	clockOffset   time.Duration
	sendExpiresIn bool
	// discardBodies keeps only each upload's size and digest (large-object
	// tests); completed multipart objects are then not stored.
	discardBodies bool
	partDigests   map[string]map[int]string
	// nowFn is the control plane's clock before clockOffset (default
	// time.Now).
	nowFn func() time.Time

	// hooks answer a request themselves when they return true.
	storageHook func(w http.ResponseWriter, r *http.Request) bool
	controlHook func(op string, body map[string]any, w http.ResponseWriter) bool
}

type writeCall struct {
	op      string
	body    map[string]any
	headers http.Header
}

func newFakeWriteBackend(t *testing.T) *fakeWriteBackend {
	t.Helper()
	b := &fakeWriteBackend{
		t:          t,
		snapshotID: testWriteSnapshotID,
		objects:    map[string][]byte{},
		uploads:    map[string]map[int][]byte{},
		uploadKeys: map[string]string{},
		sse:        map[string]string{},
	}
	b.storage = httptest.NewTLSServer(http.HandlerFunc(b.serveStorage))
	t.Cleanup(b.storage.Close)
	base := "/api/v1/agents/" + testAgentID + "/storage-sessions/" + testSessionID + "/"
	b.control = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.EscapedPath(), base) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		op := strings.TrimPrefix(r.URL.EscapedPath(), base)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		b.mu.Lock()
		b.calls = append(b.calls, writeCall{op: op, body: body, headers: r.Header.Clone()})
		hook := b.controlHook
		w.Header().Set("Date", b.serverNowLocked().UTC().Format(http.TimeFormat))
		b.mu.Unlock()
		if hook != nil && hook(op, body, w) {
			return
		}
		b.serveControl(op, body, w)
	}))
	t.Cleanup(b.control.Close)
	return b
}

func (b *fakeWriteBackend) serveStorage(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	b.storageReqs = append(b.storageReqs, r.Clone(context.Background()))
	hook := b.storageHook
	b.mu.Unlock()
	if hook != nil && hook(w, r) {
		return
	}
	q := r.URL.Query()
	key := q.Get("k")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/obj":
		b.mu.Lock()
		data, ok := b.objects[key]
		b.mu.Unlock()
		if !ok {
			http.Error(w, "NoSuchKey", http.StatusNotFound)
			return
		}
		_, _ = w.Write(data)
	case r.Method == http.MethodPut && r.URL.Path == "/part" && b.discard():
		h := sha256.New()
		if _, err := io.Copy(h, r.Body); err != nil {
			http.Error(w, "read", http.StatusBadRequest)
			return
		}
		n, _ := strconv.Atoi(q.Get("n"))
		sum := hex.EncodeToString(h.Sum(nil))
		b.mu.Lock()
		if b.partDigests == nil {
			b.partDigests = map[string]map[int]string{}
		}
		if b.partDigests[q.Get("u")] == nil {
			b.partDigests[q.Get("u")] = map[int]string{}
		}
		b.partDigests[q.Get("u")][n] = sum
		b.mu.Unlock()
		w.Header().Set("ETag", fmt.Sprintf(`"part-%d-%s"`, n, sum[:8]))
	case r.Method == http.MethodPut && r.URL.Path == "/put":
		data, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read", http.StatusBadRequest)
			return
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if _, exists := b.objects[key]; exists && r.Header.Get("If-None-Match") == "*" {
			http.Error(w, "PreconditionFailed", http.StatusPreconditionFailed)
			return
		}
		b.objects[key] = data
		w.Header().Set("ETag", `"`+digestHex(data)+`"`)
	case r.Method == http.MethodPut && r.URL.Path == "/part":
		data, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read", http.StatusBadRequest)
			return
		}
		n, _ := strconv.Atoi(q.Get("n"))
		b.mu.Lock()
		parts := b.uploads[q.Get("u")]
		if parts == nil {
			b.mu.Unlock()
			http.Error(w, "NoSuchUpload", http.StatusNotFound)
			return
		}
		parts[n] = data
		b.mu.Unlock()
		w.Header().Set("ETag", fmt.Sprintf(`"part-%d-%s"`, n, digestHex(data)[:8]))
	default:
		http.Error(w, "unexpected", http.StatusBadRequest)
	}
}

func (b *fakeWriteBackend) serverNowLocked() time.Time {
	now := time.Now
	if b.nowFn != nil {
		now = b.nowFn
	}
	return now().Add(b.clockOffset)
}

func (b *fakeWriteBackend) discard() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.discardBodies
}

func (b *fakeWriteBackend) underReservation(key string) bool {
	return strings.HasPrefix(key, "snapshots/"+b.snapshotID+"/")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (b *fakeWriteBackend) serveControl(op string, body map[string]any, w http.ResponseWriter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ttl := b.urlTTL
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	serverNow := b.serverNowLocked()
	expires := serverNow.Add(ttl).UTC().Format(time.RFC3339Nano)
	switch op {
	case "renew":
		writeJSON(w, 200, map[string]string{"expiresAt": b.serverNowLocked().Add(15 * time.Minute).UTC().Format(time.RFC3339)})
	case "objects:resolve":
		reqs, _ := body["requests"].([]any)
		objects := []map[string]any{}
		denied := []map[string]any{}
		for _, raw := range reqs {
			r := raw.(map[string]any)
			key, _ := r["key"].(string)
			method, _ := r["method"].(string)
			if !b.underReservation(key) {
				denied = append(denied, map[string]any{"key": key, "method": method, "code": "outside_reservation"})
				continue
			}
			o := map[string]any{"key": key, "method": method, "expiresAt": expires}
			if b.sendExpiresIn {
				o["expiresIn"] = int(ttl / time.Second)
			}
			switch method {
			case "GET":
				o["url"] = b.storage.URL + "/obj?k=" + url.QueryEscape(key)
				o["headers"] = map[string]string{}
			case "PUT":
				size := int64(r["size"].(float64))
				h := map[string]string{"content-length": strconv.FormatInt(size, 10)}
				for k, v := range b.sse {
					h[k] = v
				}
				if b.conditional {
					h["if-none-match"] = "*"
				}
				o["url"] = b.storage.URL + "/put?k=" + url.QueryEscape(key)
				o["headers"] = h
			case "UPLOAD_PART":
				size := int64(r["size"].(float64))
				n := int(r["partNumber"].(float64))
				u, _ := r["uploadId"].(string)
				o["url"] = fmt.Sprintf("%s/part?k=%s&u=%s&n=%d", b.storage.URL, url.QueryEscape(key), url.QueryEscape(u), n)
				o["headers"] = map[string]string{"content-length": strconv.FormatInt(size, 10)}
				o["uploadId"] = u
				o["partNumber"] = n
			}
			objects = append(objects, o)
		}
		writeJSON(w, 200, map[string]any{"objects": objects, "denied": denied})
	case "multipart:create":
		key, _ := body["key"].(string)
		if !b.underReservation(key) {
			writeJSON(w, 403, map[string]string{"code": "outside_reservation"})
			return
		}
		b.nextUpload++
		id := fmt.Sprintf("upload-%d", b.nextUpload)
		b.uploads[id] = map[int][]byte{}
		b.uploadKeys[id] = key
		answer := map[string]any{"uploadId": id}
		if b.createEncryption != nil {
			answer["appliedEncryption"] = b.createEncryption
		} else if b.createEncryptionNull {
			answer["appliedEncryption"] = nil
		}
		writeJSON(w, 200, answer)
	case "multipart:complete":
		if b.discardBodies {
			id, _ := body["uploadId"].(string)
			delete(b.uploads, id)
			writeJSON(w, 200, map[string]any{})
			return
		}
		id, _ := body["uploadId"].(string)
		key, _ := body["key"].(string)
		parts := b.uploads[id]
		if parts == nil || b.uploadKeys[id] != key {
			writeJSON(w, 403, map[string]string{"code": "unknown_upload"})
			return
		}
		if _, exists := b.objects[key]; exists && b.conditional {
			writeJSON(w, 412, map[string]string{"code": "object_exists"})
			return
		}
		list, _ := body["parts"].([]any)
		var assembled []byte
		for _, raw := range list {
			p := raw.(map[string]any)
			n := int(p["partNumber"].(float64))
			data, ok := parts[n]
			if !ok || p["etag"] != fmt.Sprintf(`"part-%d-%s"`, n, digestHex(data)[:8]) {
				writeJSON(w, 400, map[string]string{"code": "invalid_part"})
				return
			}
			assembled = append(assembled, data...)
		}
		b.objects[key] = assembled
		delete(b.uploads, id)
		writeJSON(w, 200, map[string]any{})
	case "multipart:abort":
		id, _ := body["uploadId"].(string)
		delete(b.uploads, id)
		writeJSON(w, 200, map[string]any{})
	case "objects:list":
		prefix, _ := body["prefix"].(string)
		var keys []string
		for k := range b.objects {
			if strings.HasPrefix(k, prefix) {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		start := 0
		if tok, _ := body["continuationToken"].(string); tok != "" {
			start, _ = strconv.Atoi(tok)
		}
		page := b.listPage
		if page <= 0 {
			page = 1000
		}
		end := start + page
		var next any
		if end < len(keys) {
			next = strconv.Itoa(end)
		} else {
			end = len(keys)
		}
		writeJSON(w, 200, map[string]any{"keys": append([]string{}, keys[start:end]...), "nextToken": next})
	case "objects:delete":
		list, _ := body["keys"].([]any)
		deleted := []string{}
		denied := []map[string]string{}
		for _, raw := range list {
			k := raw.(string)
			if !b.underReservation(k) {
				denied = append(denied, map[string]string{"key": k, "code": "outside_reservation"})
				continue
			}
			delete(b.objects, k)
			deleted = append(deleted, k)
		}
		writeJSON(w, 200, map[string]any{"deleted": deleted, "denied": denied, "failed": []any{}})
	case "snapshot:resume":
		writeJSON(w, 409, map[string]string{"code": "not_resumable"})
	default:
		writeJSON(w, 404, map[string]string{"error": "not found"})
	}
}

func (b *fakeWriteBackend) callsFor(op string) []writeCall {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []writeCall
	for _, c := range b.calls {
		if c.op == op {
			out = append(out, c)
		}
	}
	return out
}

func (b *fakeWriteBackend) object(key string) ([]byte, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	data, ok := b.objects[key]
	return data, ok
}

func (b *fakeWriteBackend) put(key string, data []byte) {
	b.mu.Lock()
	b.objects[key] = data
	b.mu.Unlock()
}

func (b *fakeWriteBackend) set(f func(b *fakeWriteBackend)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	f(b)
}

func (b *fakeWriteBackend) storageRequests() []*http.Request {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]*http.Request(nil), b.storageReqs...)
}

func (b *fakeWriteBackend) openUploads() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.uploads)
}

func digestHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func testWriteDescriptor(b *fakeWriteBackend, now time.Time) *Descriptor {
	return &Descriptor{
		Version:           ProtocolVersion,
		SessionID:         testSessionID,
		Token:             testSessionToken,
		BaseURL:           b.control.URL,
		ExpiresAt:         now.Add(10 * time.Minute).UTC().Format(time.RFC3339),
		Deadline:          now.Add(2 * time.Hour).UTC().Format(time.RFC3339),
		Capabilities:      []string{"resolve_batch", "renew", "put", "multipart", "list", "delete", "resume"},
		MaxBatch:          100,
		Scope:             ScopeSnapshotWrite,
		SnapshotID:        testWriteSnapshotID,
		PartSizeBytes:     64 << 20,
		ConditionalWrites: true,
	}
}

// newTestWriteProvider builds a write provider against b with both TLS test
// servers trusted.
func newTestWriteProvider(t *testing.T, b *fakeWriteBackend, opts Options) *WriteProvider {
	t.Helper()
	if opts.ControlClient == nil {
		opts.ControlClient = b.control.Client()
	}
	if opts.StorageClient == nil {
		opts.StorageClient = b.storage.Client()
	}
	if opts.ControlCallsPerMinute == 0 {
		opts.ControlCallsPerMinute = -1
	}
	creds := Credentials{AgentID: testAgentID, AgentToken: testAgentToken, ControlPlaneOrigins: []string{b.control.URL}}
	p, err := NewWriteProvider(context.Background(), testWriteDescriptor(b, time.Now()), creds, opts)
	if err != nil {
		t.Fatalf("NewWriteProvider: %v", err)
	}
	t.Cleanup(p.Close)
	return p
}

func writeTempData(t *testing.T, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "src.bin")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func patternBytes(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(i*7 + i/251)
	}
	return out
}
