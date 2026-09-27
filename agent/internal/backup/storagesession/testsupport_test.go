package storagesession

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testSessionID  = "0b6f0c7e-3d2a-4f5b-9e1c-8a7d6c5b4a39"
	testAgentID    = "agent-7c1d"
	testAgentToken = "brz_agent_token_for_tests"
)

var testSessionToken = strings.Repeat("s", 43)

// fakeStorage is an S3-like object endpoint serving presigned-style URLs of
// the form /obj?k=<key>&g=<generation>.
type fakeStorage struct {
	srv *httptest.Server

	mu       sync.Mutex
	objects  map[string][]byte
	requests []*http.Request
	// hook, when set, may answer a request itself (return true).
	hook func(w http.ResponseWriter, r *http.Request) bool
}

func newFakeStorage(t *testing.T) *fakeStorage {
	t.Helper()
	s := &fakeStorage{objects: map[string][]byte{}}
	s.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.requests = append(s.requests, r.Clone(context.Background()))
		hook := s.hook
		s.mu.Unlock()
		if hook != nil && hook(w, r) {
			return
		}
		key := r.URL.Query().Get("k")
		s.mu.Lock()
		data, ok := s.objects[key]
		s.mu.Unlock()
		if !ok {
			http.Error(w, "NoSuchKey", http.StatusNotFound)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *fakeStorage) put(key string, data []byte) {
	s.mu.Lock()
	s.objects[key] = data
	s.mu.Unlock()
}

func (s *fakeStorage) setHook(h func(w http.ResponseWriter, r *http.Request) bool) {
	s.mu.Lock()
	s.hook = h
	s.mu.Unlock()
}

func (s *fakeStorage) recorded() []*http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*http.Request(nil), s.requests...)
}

func (s *fakeStorage) urlFor(key string, generation int) string {
	return s.srv.URL + "/obj?k=" + url.QueryEscape(key) + "&g=" + strings.Repeat("x", generation)
}

type resolveCall struct {
	keys    []string
	headers http.Header
}

// fakeControlPlane implements the storage-session resolve and renew
// endpoints for one agent and one session.
type fakeControlPlane struct {
	srv     *httptest.Server
	storage *fakeStorage

	mu            sync.Mutex
	resolveCalls  []resolveCall
	renewCalls    []http.Header
	unknownPaths  []string
	urlTTL        time.Duration
	denied        map[string]bool
	generation    map[string]int
	resolveHook   func(call int, keys []string, w http.ResponseWriter) bool
	renewHook     func(call int, w http.ResponseWriter) bool
	renewedExpiry time.Time
	now           func() time.Time
}

func newFakeControlPlane(t *testing.T, storage *fakeStorage) *fakeControlPlane {
	t.Helper()
	cp := &fakeControlPlane{
		storage:    storage,
		urlTTL:     5 * time.Minute,
		denied:     map[string]bool{},
		generation: map[string]int{},
		now:        time.Now,
	}
	base := "/api/v1/agents/" + testAgentID + "/storage-sessions/" + testSessionID
	cp.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.EscapedPath() == base+"/objects:resolve":
			cp.handleResolve(w, r)
		case r.Method == http.MethodPost && r.URL.EscapedPath() == base+"/renew":
			cp.handleRenew(w, r)
		default:
			cp.mu.Lock()
			cp.unknownPaths = append(cp.unknownPaths, r.Method+" "+r.URL.EscapedPath())
			cp.mu.Unlock()
			http.Error(w, "not found", http.StatusNotFound)
		}
	}))
	t.Cleanup(cp.srv.Close)
	return cp
}

func (cp *fakeControlPlane) handleResolve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Keys []string `json:"keys"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	cp.mu.Lock()
	cp.resolveCalls = append(cp.resolveCalls, resolveCall{keys: body.Keys, headers: r.Header.Clone()})
	call := len(cp.resolveCalls)
	hook := cp.resolveHook
	cp.mu.Unlock()
	if hook != nil && hook(call, body.Keys, w) {
		return
	}
	type object struct {
		Key       string            `json:"key"`
		Method    string            `json:"method"`
		URL       string            `json:"url"`
		Headers   map[string]string `json:"headers"`
		ExpiresAt string            `json:"expiresAt"`
	}
	resp := struct {
		Objects []object `json:"objects"`
		Denied  []string `json:"denied"`
	}{Objects: []object{}, Denied: []string{}}
	cp.mu.Lock()
	for _, k := range body.Keys {
		if cp.denied[k] {
			resp.Denied = append(resp.Denied, k)
			continue
		}
		cp.generation[k]++
		resp.Objects = append(resp.Objects, object{
			Key: k, Method: "GET", URL: cp.storage.urlFor(k, cp.generation[k]),
			Headers: map[string]string{}, ExpiresAt: cp.now().Add(cp.urlTTL).UTC().Format(time.RFC3339),
		})
	}
	cp.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (cp *fakeControlPlane) handleRenew(w http.ResponseWriter, r *http.Request) {
	cp.mu.Lock()
	cp.renewCalls = append(cp.renewCalls, r.Header.Clone())
	call := len(cp.renewCalls)
	hook := cp.renewHook
	expiry := cp.renewedExpiry
	cp.mu.Unlock()
	if hook != nil && hook(call, w) {
		return
	}
	if expiry.IsZero() {
		expiry = cp.now().Add(15 * time.Minute)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"expiresAt": expiry.UTC().Format(time.RFC3339)})
}

func (cp *fakeControlPlane) calls() []resolveCall {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]resolveCall(nil), cp.resolveCalls...)
}

func (cp *fakeControlPlane) renews() int {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return len(cp.renewCalls)
}

func (cp *fakeControlPlane) set(f func(cp *fakeControlPlane)) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	f(cp)
}

// testDescriptor returns a valid descriptor pointing at cp.
func testDescriptor(cp *fakeControlPlane, now time.Time) *Descriptor {
	return &Descriptor{
		Version:      ProtocolVersion,
		SessionID:    testSessionID,
		Token:        testSessionToken,
		BaseURL:      cp.srv.URL,
		ExpiresAt:    now.Add(10 * time.Minute).UTC().Format(time.RFC3339),
		Deadline:     now.Add(2 * time.Hour).UTC().Format(time.RFC3339),
		Capabilities: []string{CapabilityResolveBatch, CapabilityRenew},
		MaxBatch:     100,
	}
}

func testCredentials(cp *fakeControlPlane) Credentials {
	return Credentials{
		AgentID:             testAgentID,
		AgentToken:          testAgentToken,
		ControlPlaneOrigins: []string{cp.srv.URL},
	}
}

// newTestProvider builds a provider against cp/storage with both TLS test
// servers trusted.
func newTestProvider(t *testing.T, cp *fakeControlPlane, d *Descriptor, opts Options) *Provider {
	t.Helper()
	if opts.ControlClient == nil {
		opts.ControlClient = cp.srv.Client()
	}
	if opts.StorageClient == nil {
		opts.StorageClient = cp.storage.srv.Client()
	}
	p, err := New(context.Background(), d, testCredentials(cp), opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(p.Close)
	return p
}

// noSleep replaces the retry sleep for the test and records every wait.
func noSleep(t *testing.T) *[]time.Duration {
	t.Helper()
	var mu sync.Mutex
	waits := []time.Duration{}
	orig := retrySleep
	retrySleep = func(ctx context.Context, d time.Duration) error {
		mu.Lock()
		waits = append(waits, d)
		mu.Unlock()
		return ctx.Err()
	}
	t.Cleanup(func() { retrySleep = orig })
	return &waits
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}
