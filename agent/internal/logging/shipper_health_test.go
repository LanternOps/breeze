package logging

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// fakeClock is a settable clock for the shipper's injectable s.now.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock(t time.Time) *fakeClock { return &fakeClock{t: t} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newHealthTestShipper(serverURL string) *Shipper {
	return NewShipper(ShipperConfig{
		ServerURL: func() string { return serverURL },
		AgentID:   "agent-health",
		AuthToken: testToken("secret-token"),
		MinLevel:  "info",
	})
}

func statusServer(t *testing.T, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func requireOutcome(t *testing.T, snap HealthSnapshot, wantOk bool, wantErr string) {
	t.Helper()
	if snap.LastAttemptOk == nil {
		t.Fatalf("LastAttemptOk = nil, want %v (snap %+v)", wantOk, snap)
	}
	if *snap.LastAttemptOk != wantOk {
		t.Fatalf("LastAttemptOk = %v, want %v (snap %+v)", *snap.LastAttemptOk, wantOk, snap)
	}
	if snap.LastError != wantErr {
		t.Fatalf("LastError = %q, want %q", snap.LastError, wantErr)
	}
}

func TestHealthSnapshot_NoAttemptsIsQuiet(t *testing.T) {
	s := newHealthTestShipper("http://127.0.0.1:1")
	snap := s.HealthSnapshot()
	if !snap.Initialized {
		t.Fatal("Initialized = false for a constructed shipper")
	}
	if snap.LastAttemptOk != nil || snap.LastError != "" ||
		!snap.LastAttemptAt.IsZero() || !snap.LastSuccessAt.IsZero() {
		t.Fatalf("no attempt yet, want an empty outcome, got %+v", snap)
	}
	if snap.QueueDepth != 0 || snap.Dropped != 0 {
		t.Fatalf("want zero queue/dropped, got %+v", snap)
	}
}

func TestLogShippingSnapshot_NoGlobalShipperIsUninitialized(t *testing.T) {
	StopShipper()
	if snap := LogShippingSnapshot(); snap.Initialized {
		t.Fatalf("no global shipper, want Initialized=false, got %+v", snap)
	}
}

func TestLogShippingSnapshot_GlobalShipperIsInitialized(t *testing.T) {
	InitShipper(ShipperConfig{
		ServerURL: func() string { return "http://127.0.0.1:1" },
		AgentID:   "agent-health",
		AuthToken: testToken("t"),
	})
	t.Cleanup(StopShipper)
	if snap := LogShippingSnapshot(); !snap.Initialized {
		t.Fatalf("global shipper running, want Initialized=true, got %+v", snap)
	}
}

// (a) success sets attempt + success times and a clean ok outcome.
func TestHealthSnapshot_SuccessRecordsOutcome(t *testing.T) {
	srv := statusServer(t, http.StatusOK)
	s := newHealthTestShipper(srv.URL)
	clock := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	s.now = clock.Now

	if !s.shipChunk(makeEntries(3)) {
		t.Fatal("shipChunk returned false on 200")
	}
	snap := s.HealthSnapshot()
	requireOutcome(t, snap, true, "")
	if !snap.LastAttemptAt.Equal(clock.Now()) || !snap.LastSuccessAt.Equal(clock.Now()) {
		t.Fatalf("attempt/success times = %v/%v, want %v", snap.LastAttemptAt, snap.LastSuccessAt, clock.Now())
	}
}

// (a2) a heartbeat landing while a request is in flight reports the prior
// completed outcome, never "failed" and never a half-written state.
func TestHealthSnapshot_InFlightReportsPriorOutcome(t *testing.T) {
	var block atomic.Bool
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if block.Load() {
			entered <- struct{}{}
			<-release
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	s := newHealthTestShipper(srv.URL)

	if !s.shipChunk(makeEntries(1)) {
		t.Fatal("first chunk failed")
	}
	before := s.HealthSnapshot()
	requireOutcome(t, before, true, "")

	block.Store(true)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.shipChunk(makeEntries(1))
	}()
	<-entered
	during := s.HealthSnapshot()
	requireOutcome(t, during, true, "")
	if !during.LastAttemptAt.Equal(before.LastAttemptAt) {
		t.Fatalf("in-flight request moved LastAttemptAt: %v -> %v", before.LastAttemptAt, during.LastAttemptAt)
	}
	close(release)
	<-done
}

// (a3) success then failure inside the same instant ends failed: the
// outcome is an explicit bool, timestamps are never compared.
func TestHealthSnapshot_SuccessThenFailureSameInstantEndsFailed(t *testing.T) {
	var unauthorized atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unauthorized.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	s := newHealthTestShipper(srv.URL)
	clock := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	s.now = clock.Now

	s.shipChunk(makeEntries(1))
	unauthorized.Store(true)
	s.shipChunk(makeEntries(1))

	snap := s.HealthSnapshot()
	requireOutcome(t, snap, false, "auth rejected")
	if !snap.LastSuccessAt.Equal(snap.LastAttemptAt) {
		t.Fatalf("success time should be kept from the earlier success: %+v", snap)
	}
}

// (a4) a completed outcome older than 10 minutes is no longer reported, so
// an agent that stopped attempting (warn-only, nothing to send) reads quiet
// instead of failing forever.
func TestHealthSnapshot_StaleOutcomeExpiresAfterTenMinutes(t *testing.T) {
	srv := statusServer(t, http.StatusUnauthorized)
	s := newHealthTestShipper(srv.URL)
	clock := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	s.now = clock.Now

	s.shipChunk(makeEntries(1))
	clock.Advance(10*time.Minute - time.Second)
	requireOutcome(t, s.HealthSnapshot(), false, "auth rejected")

	clock.Advance(time.Second) // exactly 10 minutes old
	snap := s.HealthSnapshot()
	if snap.LastAttemptOk != nil || snap.LastError != "" {
		t.Fatalf("10-minute-old failure still reported: %+v", snap)
	}
	if snap.LastAttemptAt.IsZero() {
		t.Fatal("expiry must drop the outcome, not the diagnostic attempt time")
	}
}

func TestHealthSnapshot_StaleSuccessAlsoExpires(t *testing.T) {
	srv := statusServer(t, http.StatusOK)
	s := newHealthTestShipper(srv.URL)
	clock := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	s.now = clock.Now
	s.shipChunk(makeEntries(1))
	clock.Advance(10 * time.Minute)
	if snap := s.HealthSnapshot(); snap.LastAttemptOk != nil {
		t.Fatalf("stale success still reported: %+v", snap)
	}
}

// (b) 503 on all three requests (1 + 2 retries) records one failure.
func TestHealthSnapshot_Exhausted503RecordsHTTP503(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	s := newHealthTestShipper(srv.URL)

	if s.shipChunk(makeEntries(1)) {
		t.Fatal("exhausted 503 should be terminal")
	}
	if got := requests.Load(); got != shipRetryCount+1 {
		t.Fatalf("requests = %d, want %d", got, shipRetryCount+1)
	}
	snap := s.HealthSnapshot()
	requireOutcome(t, snap, false, "http 503")
	if snap.LastAttemptAt.IsZero() || !snap.LastSuccessAt.IsZero() {
		t.Fatalf("want attempt set and success zero, got %+v", snap)
	}
}

// A transient 503 that succeeds on retry is never reported as failed.
func TestHealthSnapshot_TransientRetryThenSuccessIsOk(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	s := newHealthTestShipper(srv.URL)
	s.shipChunk(makeEntries(1))
	requireOutcome(t, s.HealthSnapshot(), true, "")
}

func TestHealthSnapshot_TerminalFailureSites(t *testing.T) {
	t.Run("other 5xx exhausted", func(t *testing.T) {
		s := newHealthTestShipper(statusServer(t, http.StatusBadGateway).URL)
		s.shipChunk(makeEntries(1))
		requireOutcome(t, s.HealthSnapshot(), false, "http 502")
	})
	t.Run("chunk-local 4xx", func(t *testing.T) {
		s := newHealthTestShipper(statusServer(t, http.StatusBadRequest).URL)
		if !s.shipChunk(makeEntries(1)) {
			t.Fatal("a 400 is chunk-local")
		}
		requireOutcome(t, s.HealthSnapshot(), false, "http 400")
	})
	t.Run("server url unresolved", func(t *testing.T) {
		s := NewShipper(ShipperConfig{AgentID: "a", AuthToken: testToken("t")})
		s.shipChunk(makeEntries(1))
		requireOutcome(t, s.HealthSnapshot(), false, "url unresolved")
	})
	t.Run("request build failure", func(t *testing.T) {
		s := newHealthTestShipper("http://bad host")
		s.shipChunk(makeEntries(1))
		requireOutcome(t, s.HealthSnapshot(), false, "url unresolved")
	})
	t.Run("marshal failure", func(t *testing.T) {
		s := newHealthTestShipper(statusServer(t, http.StatusOK).URL)
		entries := makeEntries(1)
		entries[0].Fields = map[string]any{"bad": math.NaN()}
		s.shipChunk(entries)
		requireOutcome(t, s.HealthSnapshot(), false, "other")
	})
	t.Run("network error exhausted", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := ln.Addr().String()
		ln.Close() // nothing listens: connection refused
		s := newHealthTestShipper("http://" + addr)
		s.shipChunk(makeEntries(1))
		requireOutcome(t, s.HealthSnapshot(), false, "connection refused")
	})
}

// Auth-dead skip re-buffers without a request: no outcome is recorded.
func TestHealthSnapshot_AuthSkipRecordsNothing(t *testing.T) {
	s := newHealthTestShipper("http://127.0.0.1:1")
	s.authMon = skipAll{}
	s.shipBatch(makeEntries(2))
	if snap := s.HealthSnapshot(); snap.LastAttemptOk != nil || !snap.LastAttemptAt.IsZero() {
		t.Fatalf("auth-skip recorded an attempt: %+v", snap)
	}
}

type skipAll struct{}

func (skipAll) ShouldSkip() bool   { return true }
func (skipAll) RecordAuthFailure() {}
func (skipAll) RecordSuccess()     {}

// (c) the sanitizer maps to a closed vocabulary and never echoes err text.
func TestSanitizeShipError_ClosedVocabulary(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		want   string
	}{
		{"401", nil, http.StatusUnauthorized, "auth rejected"},
		{"503", nil, http.StatusServiceUnavailable, "http 503"},
		{"400", nil, http.StatusBadRequest, "http 400"},
		{"nil error", nil, 0, "other"},
		{"url unresolved sentinel", fmt.Errorf("%w: provider returned empty", errShipURLUnresolved), 0, "url unresolved"},
		{"url parse", &url.Error{Op: "parse", URL: "http://bad host", Err: errors.New("invalid character")}, 0, "url unresolved"},
		{"dns", &url.Error{Op: "Post", URL: "https://x", Err: &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "breeze.internal"}}}, 0, "dns"},
		{"dns timeout is dns", &net.DNSError{Err: "i/o timeout", Name: "h", IsTimeout: true}, 0, "dns"},
		{"tls verify", &url.Error{Op: "Post", URL: "https://x", Err: &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}}, 0, "tls"},
		{"x509 hostname", x509.HostnameError{Host: "h"}, 0, "tls"},
		{"tls record header", tls.RecordHeaderError{Msg: "first record does not look like a TLS handshake"}, 0, "tls"},
		{"refused errno", &net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, 0, "connection refused"},
		{"refused windows text", errors.New("dial tcp: connectex: No connection could be made because the target machine actively refused it."), 0, "connection refused"},
		{"deadline", &url.Error{Op: "Post", URL: "https://x", Err: context.DeadlineExceeded}, 0, "timeout"},
		{"net timeout", &net.OpError{Op: "read", Err: timeoutErr{}}, 0, "timeout"},
		{"unknown", errors.New("something odd"), 0, "other"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeShipError(tc.err, tc.status); got != tc.want {
				t.Fatalf("sanitizeShipError = %q, want %q", got, tc.want)
			}
		})
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func TestSanitizeShipError_NeverLeaksErrorText(t *testing.T) {
	secretURL := "https://10.0.0.5/api/v1/agents/x/logs?t=Bearer%20abc"
	errs := []error{
		&url.Error{Op: "Post", URL: secretURL, Err: errors.New(`open C:\ProgramData\Breeze\agent.yaml: Bearer abc 10.0.0.5 /etc/breeze`)},
		&url.Error{Op: "Post", URL: secretURL, Err: &net.OpError{Op: "dial", Net: "tcp", Addr: &net.TCPAddr{IP: net.ParseIP("10.0.0.5"), Port: 443}, Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}},
		&url.Error{Op: "Post", URL: secretURL, Err: &net.DNSError{Err: "no such host", Name: "10.0.0.5"}},
		&url.Error{Op: "Post", URL: secretURL, Err: context.DeadlineExceeded},
		fmt.Errorf("%w: https://10.0.0.5", errShipURLUnresolved),
		errors.New(strings.Repeat("Bearer abc https://10.0.0.5/x ", 50)),
	}
	for _, err := range errs {
		got := sanitizeShipError(err, 0)
		for _, bad := range []string{"https://", "10.0.0.5", "/api", "/", `\`, "Bearer", "abc", "breeze"} {
			if strings.Contains(got, bad) {
				t.Fatalf("sanitized %q leaks %q (from %v)", got, bad, err)
			}
		}
		if len(got) > maxShipErrorBytes || maxShipErrorBytes > 160 {
			t.Fatalf("sanitized %q exceeds bound %d", got, maxShipErrorBytes)
		}
	}
}

// (d) Enqueue, terminal outcomes and snapshots from 8 goroutines at once:
// must be clean under -race.
func TestHealthSnapshot_ConcurrentEnqueueShipSnapshot(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1)%2 == 0 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	s := newHealthTestShipper(srv.URL)

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				switch g % 3 {
				case 0:
					s.Enqueue(LogEntry{Message: "m"})
				case 1:
					s.shipChunk(makeEntries(1))
				default:
					snap := s.HealthSnapshot()
					checkSnapshotConsistent(t, snap)
				}
			}
		}(g)
	}
	wg.Wait()
}

func checkSnapshotConsistent(t *testing.T, snap HealthSnapshot) {
	t.Helper()
	if snap.LastAttemptOk == nil {
		if snap.LastError != "" {
			t.Errorf("no outcome but LastError=%q", snap.LastError)
		}
		return
	}
	if *snap.LastAttemptOk && snap.LastError != "" {
		t.Errorf("torn snapshot: ok=true with LastError=%q", snap.LastError)
	}
	if !*snap.LastAttemptOk && snap.LastError == "" {
		t.Errorf("torn snapshot: ok=false with empty LastError")
	}
	if *snap.LastAttemptOk && !snap.LastSuccessAt.Equal(snap.LastAttemptAt) {
		t.Errorf("torn snapshot: ok=true but success %v != attempt %v", snap.LastSuccessAt, snap.LastAttemptAt)
	}
}

// The attempt record is one immutable value behind one pointer, so a
// reader can never observe ok=true together with a failure's error text.
// Splitting it into separate atomics makes this test go red.
func TestHealthSnapshot_NeverTears(t *testing.T) {
	s := newHealthTestShipper("http://127.0.0.1:1")
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			if i%2 == 0 {
				s.recordShipSuccess()
			} else {
				s.recordShipFailure("http 503")
			}
		}
	}()
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) && !t.Failed() {
		checkSnapshotConsistent(t, s.HealthSnapshot())
	}
	close(stop)
	wg.Wait()
}

// (f) during an outage the loop holds the batch it is shipping in a local
// slice, so len(buffer) alone reads ~0; QueueDepth must count the held batch.
func TestHealthSnapshot_QueueDepthCountsHeldBatch(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var first atomic.Bool
	first.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if first.CompareAndSwap(true, false) {
			entered <- struct{}{}
			<-release
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock() // runs before srv.Close, so a failed assertion cannot deadlock it
	s := newHealthTestShipper(srv.URL)
	s.Start()
	defer s.Stop()

	for i := 0; i < defaultMaxBatchSize; i++ {
		s.Enqueue(LogEntry{Message: "m"})
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("ship loop never sent the full batch")
	}
	for i := 0; i < 10; i++ {
		s.Enqueue(LogEntry{Message: "m"})
	}
	if got, want := s.HealthSnapshot().QueueDepth, defaultMaxBatchSize+10; got != want {
		t.Fatalf("QueueDepth during held batch = %d, want %d", got, want)
	}
	unblock()
	s.Stop()
	if got := s.HealthSnapshot().QueueDepth; got != 0 {
		t.Fatalf("QueueDepth after drain = %d, want 0", got)
	}
}

func TestHealthSnapshot_DroppedMirrorsCounter(t *testing.T) {
	s := newHealthTestShipper("http://127.0.0.1:1")
	s.droppedCount.Store(7)
	if got := s.HealthSnapshot().Dropped; got != 7 {
		t.Fatalf("Dropped = %d, want 7", got)
	}
}
