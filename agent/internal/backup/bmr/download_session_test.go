package bmr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// Tests for #5635: the recovery download client's session handling.
//
// Observed in the W04b KIT proof (recovery 61f8f8d5): once the download
// session window closed, Download re-authenticated once PER FAILED FILE with
// no cap or backoff. The per-token authenticate limit (3/h) answered ~300
// 429s and the console scrolled "authenticate failed: Too many requests" for
// tens of thousands of files. These tests pin the replacement contract:
//
//   - re-authentication is single-flight and bounded; 429s honour
//     Retry-After (else exponential with a ceiling) and, repeated, become a
//     run-level ErrRecoverySessionLost instead of a per-file warning;
//   - the session is refreshed ONCE shortly before the descriptor's
//     expiresAt, so a long restore never sees the 401 at all.
//
// Everything runs on a fake clock shared by the provider and the fake
// server; retrySleep is replaced by a recorder that advances that clock, so
// no test sleeps for real.

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 12, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// withClockSleep replaces retrySleep with a recorder that advances clock by
// the requested duration instead of blocking.
func withClockSleep(t *testing.T, clock *fakeClock) func() []time.Duration {
	t.Helper()
	var mu sync.Mutex
	var recorded []time.Duration
	orig := retrySleep
	retrySleep = func(ctx context.Context, d time.Duration) error {
		mu.Lock()
		recorded = append(recorded, d)
		mu.Unlock()
		clock.Advance(d)
		return ctx.Err()
	}
	// Exact waits: the jitter itself is pinned by TestSessionRetryJitterIsBounded.
	origJitter := sessionRetryJitter
	sessionRetryJitter = func(d time.Duration) time.Duration { return d }
	t.Cleanup(func() {
		retrySleep = orig
		sessionRetryJitter = origJitter
	})
	return func() []time.Duration {
		mu.Lock()
		defer mu.Unlock()
		return append([]time.Duration(nil), recorded...)
	}
}

type fakeAuthResponse struct {
	status     int
	retryAfter string
	message    string
}

// sessionFakeServer models /bmr/recover/authenticate + /bmr/recover/download
// with a server-side session window on the shared fake clock.
type sessionFakeServer struct {
	clock *fakeClock
	srv   *httptest.Server

	mu sync.Mutex
	// authResponses is consumed in order; the last entry repeats. A 200
	// (re)opens the session until now+sessionTTL (or fixedExpiry).
	authResponses []fakeAuthResponse
	sessionTTL    time.Duration
	// fixedExpiry, when non-zero, is advertised (and enforced) as the
	// session expiry regardless of when authenticate ran — models the
	// token-expiry cap in computeRecoveryDownloadExpiry.
	fixedExpiry time.Time
	// sessionAlwaysValid ignores the window for downloads (clock-skew case:
	// the server's own clock says the session is fine).
	sessionAlwaysValid bool
	// downloadStatus, when non-zero, is returned for every download.
	downloadStatus int

	sessionExpiresAt time.Time
	authCalls        int
	downloadCalls    int
	unauthorized     int

	// issueRenewal is returned as bootstrap.sessionRenewal on a 200 (#12566);
	// renewalsSeen records the sessionRenewal each authenticate carried
	// ("" when the field was absent).
	issueRenewal string
	renewalsSeen []string
}

func newSessionFakeServer(t *testing.T, clock *fakeClock) *sessionFakeServer {
	t.Helper()
	s := &sessionFakeServer{
		clock:         clock,
		sessionTTL:    time.Hour,
		authResponses: []fakeAuthResponse{{status: http.StatusOK}},
	}
	s.srv = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *sessionFakeServer) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch r.URL.Path {
	case "/api/v1/backup/bmr/recover/authenticate":
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		seen, _ := req["sessionRenewal"].(string)
		s.renewalsSeen = append(s.renewalsSeen, seen)
		idx := s.authCalls
		s.authCalls++
		if idx >= len(s.authResponses) {
			idx = len(s.authResponses) - 1
		}
		resp := s.authResponses[idx]
		if resp.status != http.StatusOK {
			if resp.retryAfter != "" {
				w.Header().Set("Retry-After", resp.retryAfter)
			}
			msg := resp.message
			if msg == "" {
				msg = http.StatusText(resp.status)
			}
			w.WriteHeader(resp.status)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
			return
		}
		expires := s.clock.Now().Add(s.sessionTTL)
		if !s.fixedExpiry.IsZero() {
			expires = s.fixedExpiry
		}
		s.sessionExpiresAt = expires
		_ = json.NewEncoder(w).Encode(map[string]any{"bootstrap": BootstrapResponse{
			Version:        BootstrapResponseVersion,
			TokenID:        "token-1",
			DeviceID:       "device-1",
			SnapshotID:     "db-snapshot-1",
			Snapshot:       &AuthenticatedSnapshot{ID: "db-snapshot-1", SnapshotID: "snap-1"},
			Download:       s.descriptorLocked(),
			SessionRenewal: s.issueRenewal,
		}})
	case "/download":
		s.downloadCalls++
		if s.downloadStatus != 0 {
			w.WriteHeader(s.downloadStatus)
			_, _ = io.WriteString(w, `{"error":"forced"}`)
			return
		}
		if !s.sessionAlwaysValid && !s.clock.Now().Before(s.sessionExpiresAt) {
			s.unauthorized++
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"Recovery session has expired. Re-authenticate to continue."}`)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	default:
		http.NotFound(w, r)
	}
}

func (s *sessionFakeServer) descriptorLocked() *AuthenticatedDownloadDescriptor {
	return &AuthenticatedDownloadDescriptor{
		Type:              "breeze_proxy",
		URL:               s.srv.URL + "/download",
		TokenHeaderName:   "authorization",
		TokenHeaderFormat: "Bearer <recovery-token>",
		PathQueryParam:    "path",
		PathPrefix:        "snapshots/snap-1",
		// Same shape as the API's Date#toISOString().
		ExpiresAt: s.sessionExpiresAt.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
	}
}

// openSession simulates the bootstrap authenticate that happened before the
// provider was built: the session is valid until expiresAt.
func (s *sessionFakeServer) openSession(expiresAt time.Time) *AuthenticatedDownloadDescriptor {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessionExpiresAt = expiresAt
	return s.descriptorLocked()
}

func (s *sessionFakeServer) setAuthResponses(r ...fakeAuthResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authResponses = r
}

func (s *sessionFakeServer) renewals() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.renewalsSeen...)
}

func (s *sessionFakeServer) counts() (auth, downloads, unauthorized int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.authCalls, s.downloadCalls, s.unauthorized
}

func (s *sessionFakeServer) provider(clock *fakeClock, desc *AuthenticatedDownloadDescriptor) *recoveryDownloadProvider {
	p := newRecoveryDownloadProvider(context.Background(), s.srv.URL, "brz_rec_test", desc)
	p.now = clock.Now
	p.lastAuthAt = clock.Now()
	return p
}

func downloadN(t *testing.T, p *recoveryDownloadProvider, n int) []error {
	t.Helper()
	dir := t.TempDir()
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		errs[i] = p.Download(fmt.Sprintf("snapshots/snap-1/f%d", i), filepath.Join(dir, fmt.Sprintf("f%d", i)))
	}
	return errs
}

func requireAllNil(t *testing.T, errs []error) {
	t.Helper()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("download %d: unexpected error %v", i, err)
		}
	}
}

// TestRecoverySessionReauthFailuresBecomeRunLevel covers the reactive path:
// the session has already closed, so the first download 401s and the client
// must re-authenticate. Each case pins how many authenticate calls may be
// spent, the exact backoff schedule, and whether the run survives. The
// failing cases also prove every LATER Download short-circuits with
// ErrRecoverySessionLost without touching the network (the old code called
// authenticate once per remaining file).
func TestRecoverySessionReauthFailuresBecomeRunLevel(t *testing.T) {
	tooMany := func(retryAfter string) fakeAuthResponse {
		return fakeAuthResponse{status: http.StatusTooManyRequests, retryAfter: retryAfter, message: "Too many requests"}
	}
	unavailable := fakeAuthResponse{status: http.StatusServiceUnavailable}
	ok := fakeAuthResponse{status: http.StatusOK}

	cases := []struct {
		name          string
		auth          []fakeAuthResponse
		wantAuthCalls int
		wantSleeps    []time.Duration
		wantLost      bool
		wantErrSubstr string
	}{
		{
			// #12566: a rate-limited renewal keeps waiting out the
			// server's Retry-After instead of giving up after three
			// quick tries; the attempt cap still ends the run.
			name:          "repeated 429 honours Retry-After then fails the run",
			auth:          []fakeAuthResponse{tooMany("30")},
			wantAuthCalls: reauthMaxRateLimitedAttempts,
			wantSleeps:    []time.Duration{30 * time.Second, 30 * time.Second, 30 * time.Second, 30 * time.Second, 30 * time.Second},
			wantLost:      true,
			wantErrSubstr: "Too many requests",
		},
		{
			// #12566: the reported failure. Refused renewals used to be
			// counted by the server, so the first Retry-After was short
			// and the helper's three quick retries were all refused. A
			// renewal that is refused for a few minutes now survives.
			name:          "429 for several minutes then success keeps the run going",
			auth:          []fakeAuthResponse{tooMany("12"), tooMany("2"), tooMany("120"), ok},
			wantAuthCalls: 4,
			wantSleeps:    []time.Duration{12 * time.Second, 2 * time.Second, 120 * time.Second},
		},
		{
			name:          "429 without Retry-After backs off exponentially",
			auth:          []fakeAuthResponse{tooMany(""), tooMany(""), ok},
			wantAuthCalls: 3,
			wantSleeps:    []time.Duration{reauthInitialDelay, 2 * reauthInitialDelay},
		},
		{
			// The per-token limit's window is an hour; the agent-wide
			// Retry-After clamp (httputil.ParseRetryAfter, 5m) bounds
			// each wait, and the total wait budget ends the run.
			name:          "hour-long Retry-After is clamped and still bounded",
			auth:          []fakeAuthResponse{tooMany("3000")},
			wantAuthCalls: 5,
			wantSleeps:    []time.Duration{5 * time.Minute, 5 * time.Minute, 5 * time.Minute, 5 * time.Minute},
			wantLost:      true,
			wantErrSubstr: "still rate-limited after waiting 20m0s",
		},
		{
			name:          "transient failures back off to the ceiling then fail",
			auth:          []fakeAuthResponse{unavailable},
			wantAuthCalls: reauthMaxAttempts,
			wantSleeps:    []time.Duration{15 * time.Second, 30 * time.Second, 60 * time.Second, 60 * time.Second},
			wantLost:      true,
		},
		{
			name:          "transient failure then success keeps the run going",
			auth:          []fakeAuthResponse{unavailable, ok},
			wantAuthCalls: 2,
			wantSleeps:    []time.Duration{reauthInitialDelay},
		},
		{
			name:          "rejected token fails the run on the first attempt",
			auth:          []fakeAuthResponse{{status: http.StatusUnauthorized, message: "Token is revoked"}},
			wantAuthCalls: 1,
			wantLost:      true,
			wantErrSubstr: "Token is revoked",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clock := newFakeClock()
			sleeps := withClockSleep(t, clock)
			server := newSessionFakeServer(t, clock)
			server.setAuthResponses(tc.auth...)
			// Session already closed a moment ago.
			p := server.provider(clock, server.openSession(clock.Now().Add(-time.Second)))

			errs := downloadN(t, p, 10)
			authCalls, _, _ := server.counts()

			if authCalls != tc.wantAuthCalls {
				t.Fatalf("authenticate calls = %d, want %d", authCalls, tc.wantAuthCalls)
			}
			if got := sleeps(); fmt.Sprint(got) != fmt.Sprint(tc.wantSleeps) {
				t.Fatalf("backoff sleeps = %v, want %v", got, tc.wantSleeps)
			}
			if !tc.wantLost {
				requireAllNil(t, errs)
				return
			}
			for i, err := range errs {
				if !errors.Is(err, ErrRecoverySessionLost) {
					t.Fatalf("download %d: err = %v, want ErrRecoverySessionLost", i, err)
				}
			}
			if tc.wantErrSubstr != "" && !strings.Contains(errs[0].Error(), tc.wantErrSubstr) {
				t.Fatalf("first error = %q, want it to mention %q", errs[0], tc.wantErrSubstr)
			}
			_, downloads, _ := server.counts()
			if downloads != 1 {
				t.Fatalf("download requests = %d, want 1 (later files must short-circuit on the lost session)", downloads)
			}
		})
	}
}

// TestRecoverySessionStillUnauthorizedAfterReauthIsRunLevel: a session that
// was JUST re-established and still answers 401 cannot be rescued by
// authenticating again — that is exactly the per-file loop to prevent.
func TestRecoverySessionStillUnauthorizedAfterReauthIsRunLevel(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	server.downloadStatus = http.StatusUnauthorized
	p := server.provider(clock, server.openSession(clock.Now().Add(time.Hour)))

	errs := downloadN(t, p, 5)
	authCalls, downloads, _ := server.counts()
	if authCalls != 1 {
		t.Fatalf("authenticate calls = %d, want 1", authCalls)
	}
	if downloads != 2 {
		t.Fatalf("download requests = %d, want 2 (original + one post-refresh retry)", downloads)
	}
	for i, err := range errs {
		if !errors.Is(err, ErrRecoverySessionLost) {
			t.Fatalf("download %d: err = %v, want ErrRecoverySessionLost", i, err)
		}
	}
}

// TestRecoverySessionForbiddenDoesNotReauthenticate: the recovery download
// route never answers 403 — every session-level rejection is 401 — so a 403
// can only come from a storage redirect target (e.g. S3 answering
// AccessDenied for one object). Re-authenticating cannot fix that, and doing
// it per file is the same authenticate flood this issue is about.
func TestRecoverySessionForbiddenDoesNotReauthenticate(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	server.downloadStatus = http.StatusForbidden
	p := server.provider(clock, server.openSession(clock.Now().Add(time.Hour)))

	errs := downloadN(t, p, 5)
	authCalls, _, _ := server.counts()
	if authCalls != 0 {
		t.Fatalf("authenticate calls = %d, want 0", authCalls)
	}
	for i, err := range errs {
		if err == nil || errors.Is(err, ErrRecoverySessionLost) {
			t.Fatalf("download %d: err = %v, want a per-file (non run-level) failure", i, err)
		}
	}
}

// TestRecoverySessionProactiveRefresh covers the proactive path: the client
// refreshes once, shortly before expiresAt, so a restore that runs past the
// session TTL never sees a 401 and spends one authenticate per window.
func TestRecoverySessionProactiveRefresh(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	p := server.provider(clock, server.openSession(clock.Now().Add(time.Hour)))

	requireAllNil(t, downloadN(t, p, 3))
	if auth, _, _ := server.counts(); auth != 0 {
		t.Fatalf("authenticate calls before the refresh lead = %d, want 0", auth)
	}

	// Inside the refresh lead: exactly one refresh, however many files.
	clock.Advance(time.Hour - sessionRefreshLead + time.Minute)
	requireAllNil(t, downloadN(t, p, 5))
	clock.Advance(5 * time.Minute) // past the ORIGINAL expiry
	requireAllNil(t, downloadN(t, p, 5))
	if auth, _, unauthorized := server.counts(); auth != 1 || unauthorized != 0 {
		t.Fatalf("after first window: authenticate=%d unauthorized=%d, want 1 and 0", auth, unauthorized)
	}

	// Next window refreshes once more, still without a 401.
	clock.Advance(time.Hour - sessionRefreshLead)
	requireAllNil(t, downloadN(t, p, 5))
	if auth, _, unauthorized := server.counts(); auth != 2 || unauthorized != 0 {
		t.Fatalf("after second window: authenticate=%d unauthorized=%d, want 2 and 0", auth, unauthorized)
	}
}

// TestRecoverySessionProactiveRefreshIsBounded pins that the proactive path
// never degenerates into a per-file authenticate: not when the refresh does
// not extend the expiry (token-expiry cap), not when it fails, and not when
// the recovery environment's clock is hours off from the server's (RTC not
// set) so expiresAt always looks imminent.
func TestRecoverySessionProactiveRefreshIsBounded(t *testing.T) {
	t.Run("expiry capped by the token does not refresh per file", func(t *testing.T) {
		clock := newFakeClock()
		withClockSleep(t, clock)
		server := newSessionFakeServer(t, clock)
		capAt := clock.Now().Add(time.Hour)
		server.fixedExpiry = capAt
		p := server.provider(clock, server.openSession(capAt))

		clock.Advance(time.Hour - sessionRefreshLead + time.Minute)
		requireAllNil(t, downloadN(t, p, 10))
		if auth, _, _ := server.counts(); auth != 1 {
			t.Fatalf("authenticate calls = %d, want 1", auth)
		}
	})

	t.Run("failed refresh is not fatal and not retried per file", func(t *testing.T) {
		clock := newFakeClock()
		sleeps := withClockSleep(t, clock)
		server := newSessionFakeServer(t, clock)
		server.setAuthResponses(fakeAuthResponse{status: http.StatusServiceUnavailable})
		p := server.provider(clock, server.openSession(clock.Now().Add(time.Hour)))

		clock.Advance(time.Hour - sessionRefreshLead + time.Minute)
		requireAllNil(t, downloadN(t, p, 10))
		if auth, _, _ := server.counts(); auth != 1 {
			t.Fatalf("authenticate calls = %d, want 1", auth)
		}
		if got := sleeps(); len(got) != 0 {
			t.Fatalf("proactive refresh must not block downloads; slept %v", got)
		}
	})

	t.Run("client clock hours ahead of the server", func(t *testing.T) {
		clock := newFakeClock()
		withClockSleep(t, clock)
		server := newSessionFakeServer(t, clock)
		server.sessionAlwaysValid = true
		// Server-issued expiry that is already hours in the past on the
		// client's clock; every refresh returns one that is too.
		server.fixedExpiry = clock.Now().Add(-3 * time.Hour)
		p := server.provider(clock, server.openSession(server.fixedExpiry))

		requireAllNil(t, downloadN(t, p, 20))
		clock.Advance(10 * time.Minute)
		requireAllNil(t, downloadN(t, p, 20))
		if auth, _, _ := server.counts(); auth > 1 {
			t.Fatalf("authenticate calls in the first 10 minutes = %d, want at most 1", auth)
		}
		clock.Advance(proactiveRefreshMinInterval)
		requireAllNil(t, downloadN(t, p, 20))
		if auth, _, _ := server.counts(); auth > 2 {
			t.Fatalf("authenticate calls after one min-interval = %d, want at most 2", auth)
		}
	})
}

// TestRecoverySessionProactiveRateLimitGatesReactiveRefresh: a 429 on the
// proactive refresh records the server's Retry-After, and the reactive
// refresh that follows once the session closes waits out the REMAINDER of
// that window instead of hitting authenticate again immediately.
func TestRecoverySessionProactiveRateLimitGatesReactiveRefresh(t *testing.T) {
	clock := newFakeClock()
	sleeps := withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	server.setAuthResponses(
		fakeAuthResponse{status: http.StatusTooManyRequests, retryAfter: "300"},
		fakeAuthResponse{status: http.StatusOK},
	)
	p := server.provider(clock, server.openSession(clock.Now().Add(time.Hour)))

	clock.Advance(time.Hour - 2*time.Minute) // inside the lead → proactive 429, gate until +3m
	requireAllNil(t, downloadN(t, p, 1))
	clock.Advance(2 * time.Minute) // session closed; 2 of the 5 minutes elapsed
	requireAllNil(t, downloadN(t, p, 1))

	if auth, _, _ := server.counts(); auth != 2 {
		t.Fatalf("authenticate calls = %d, want 2", auth)
	}
	if got := sleeps(); fmt.Sprint(got) != fmt.Sprint([]time.Duration{3 * time.Minute}) {
		t.Fatalf("reactive wait = %v, want the remaining 3m of Retry-After", got)
	}
}

// TestRecoverySessionConcurrentExpiryReauthenticatesOnce: several downloads
// hitting the closed session at once share ONE authenticate (single-flight).
func TestRecoverySessionConcurrentExpiryReauthenticatesOnce(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	p := server.provider(clock, server.openSession(clock.Now().Add(-time.Second)))

	dir := t.TempDir()
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = p.Download(fmt.Sprintf("snapshots/snap-1/c%d", i), filepath.Join(dir, fmt.Sprintf("c%d", i)))
		}(i)
	}
	wg.Wait()
	requireAllNil(t, errs)
	if auth, _, _ := server.counts(); auth != 1 {
		t.Fatalf("authenticate calls = %d, want 1", auth)
	}
}

// TestRecoverySessionCancelDuringReauthBackoff: cancelling the recovery
// while a re-authenticate backoff is pending returns the context error at
// once — no further authenticate — and does NOT poison the session as lost.
func TestRecoverySessionCancelDuringReauthBackoff(t *testing.T) {
	clock := newFakeClock()
	server := newSessionFakeServer(t, clock)
	server.setAuthResponses(fakeAuthResponse{status: http.StatusServiceUnavailable})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	orig := retrySleep
	retrySleep = func(ctx context.Context, d time.Duration) error {
		cancel()
		return ctx.Err()
	}
	t.Cleanup(func() { retrySleep = orig })

	desc := server.openSession(clock.Now().Add(-time.Second))
	p := newRecoveryDownloadProvider(ctx, server.srv.URL, "brz_rec_test", desc)
	p.now = clock.Now
	p.lastAuthAt = clock.Now()

	err := p.Download("snapshots/snap-1/f0", filepath.Join(t.TempDir(), "f0"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if errors.Is(err, ErrRecoverySessionLost) || p.sessionLost() != nil {
		t.Fatalf("cancellation must not mark the session lost (err=%v, lost=%v)", err, p.sessionLost())
	}
	if auth, _, _ := server.counts(); auth != 1 {
		t.Fatalf("authenticate calls = %d, want 1", auth)
	}
}

// TestRecoverySessionRefreshWithoutDescriptorIsRunLevel: a refreshed
// bootstrap with no download descriptor leaves nothing to download with.
func TestRecoverySessionRefreshWithoutDescriptorIsRunLevel(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	var authCalls int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/backup/bmr/recover/authenticate":
			mu.Lock()
			authCalls++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"bootstrap": BootstrapResponse{
				Version:      BootstrapResponseVersion,
				Snapshot:     &AuthenticatedSnapshot{SnapshotID: "snap-1"},
				TargetConfig: map[string]any{"provider": "local"},
			}})
		default:
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"Recovery session has expired. Re-authenticate to continue."}`)
		}
	}))
	t.Cleanup(srv.Close)

	p := newRecoveryDownloadProvider(context.Background(), srv.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL: srv.URL + "/download", PathQueryParam: "path", PathPrefix: "snapshots/snap-1",
	})
	p.now = clock.Now
	errs := downloadN(t, p, 3)
	for i, err := range errs {
		if !errors.Is(err, ErrRecoverySessionLost) {
			t.Fatalf("download %d: err = %v, want ErrRecoverySessionLost", i, err)
		}
	}
	if authCalls != 1 {
		t.Fatalf("authenticate calls = %d, want 1", authCalls)
	}
}

// TestRecoverySessionNoProactiveRefreshWithoutExpiry: a descriptor with no
// (or an unparseable) expiresAt never triggers a proactive refresh — only a
// real 401 does.
func TestRecoverySessionNoProactiveRefreshWithoutExpiry(t *testing.T) {
	for _, expiresAt := range []string{"", "not-a-time"} {
		t.Run(fmt.Sprintf("expiresAt=%q", expiresAt), func(t *testing.T) {
			clock := newFakeClock()
			withClockSleep(t, clock)
			server := newSessionFakeServer(t, clock)
			server.sessionAlwaysValid = true
			desc := server.openSession(clock.Now().Add(time.Hour))
			desc.ExpiresAt = expiresAt
			p := server.provider(clock, desc)

			clock.Advance(3 * time.Hour)
			requireAllNil(t, downloadN(t, p, 5))
			if auth, _, _ := server.counts(); auth != 0 {
				t.Fatalf("authenticate calls = %d, want 0", auth)
			}
		})
	}
}

// TestApplySystemStateSurfacesRecoverySessionLost: the system-state manifest
// is the run's first provider download after the snapshot manifest. A lost
// session there is not "this snapshot has no system state" — it must come
// back as an error, not the soft skip.
func TestApplySystemStateSurfacesRecoverySessionLost(t *testing.T) {
	provider := &breakerFakeProvider{
		downloadErr: func(int) error {
			return fmt.Errorf("%w: re-authenticate rejected", ErrRecoverySessionLost)
		},
	}
	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: "snap-1"}, provider)
	if !errors.Is(result.err, ErrRecoverySessionLost) {
		t.Fatalf("result.err = %v, want ErrRecoverySessionLost", result.err)
	}
	for _, w := range result.warnings {
		if strings.Contains(w, "no system state found") {
			t.Fatalf("lost session reported as missing system state: %q", w)
		}
	}
}

// TestRestoreFilesAbortsImmediatelyOnRecoverySessionLost: a lost recovery
// session is a run-level failure — every remaining file would fail the same
// way — so restoreFiles must stop at the first one instead of logging
// maxConsecutiveDownloadFailures per-file warnings first.
func TestRestoreFilesAbortsImmediatelyOnRecoverySessionLost(t *testing.T) {
	const totalFiles = 10
	snapshotID := "bmr-session-lost"
	restoreRoot := t.TempDir()

	provider := &breakerFakeProvider{
		downloadErr: func(idx int) error {
			if idx < 2 {
				return nil
			}
			return fmt.Errorf("%w: authenticate failed: Too many requests", ErrRecoverySessionLost)
		},
	}

	files := make([]manifestFile, totalFiles)
	for i := 0; i < totalFiles; i++ {
		files[i] = manifestFile{
			SourcePath: filepath.Join(restoreRoot, fmt.Sprintf("f%d", i)),
			BackupPath: path.Join("snapshots", snapshotID, "files", fmt.Sprintf("f%d.gz", i)),
			Size:       10,
		}
	}
	manifest := &snapshotManifest{ID: snapshotID, Files: files, Size: int64(totalFiles * 10)}

	filesRestored, _, _, failedFiles, err := restoreFilesPlanned(context.Background(), manifest, RecoveryConfig{}, provider)
	if !errors.Is(err, ErrRecoverySessionLost) {
		t.Fatalf("err = %v, want ErrRecoverySessionLost", err)
	}
	if provider.calls != 3 {
		t.Fatalf("provider.Download calls = %d, want 3 (stop at the first lost-session failure)", provider.calls)
	}
	if filesRestored != 2 || failedFiles != 1 {
		t.Fatalf("filesRestored=%d failedFiles=%d, want 2 and 1", filesRestored, failedFiles)
	}
}

// writeTestBootstrapEnvelopeWithCapabilities writes an authenticate-response
// envelope shaped like writeTestBootstrapEnvelope (session_test.go) but with
// an explicit download.capabilities list, since that shared helper never
// sets capabilities at all (see its own doc comment — the exact envelope
// shape was not independently re-verified byte-for-byte in the W09 research
// pass). Task 9 needs to control this field precisely to exercise both the
// "capability preserved" and "capability dropped" refresh paths.
func writeTestBootstrapEnvelopeWithCapabilities(t *testing.T, w http.ResponseWriter, snapshotID string, capabilities []string) {
	t.Helper()
	download := map[string]any{
		"type": "breeze_proxy", "url": "https://example.invalid/download",
		"pathQueryParam": "path", "pathPrefix": "snapshots/" + snapshotID,
	}
	if capabilities != nil {
		download["capabilities"] = capabilities
	}
	bootstrap := map[string]any{
		"version": 1,
		"snapshot": map[string]any{
			"id": "s1", "snapshotId": snapshotID, "backupType": "file",
		},
		"download": download,
	}
	body := map[string]any{"bootstrap": bootstrap}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Fatalf("encode bootstrap envelope: %v", err)
	}
}

// TestDownloadSession_RefreshPreservesAdmissibleSet proves a session refresh
// that re-grants snapshot-file-membership-v1 keeps the admissible set built
// before the refresh (Task 9): the set is never rebuilt or cleared by
// authenticateAndSwap, only ever widened elsewhere (Task 10's
// ApplyManifestScope).
func TestDownloadSession_RefreshPreservesAdmissibleSet(t *testing.T) {
	authCalls := int32(0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/recover/authenticate") {
			atomic.AddInt32(&authCalls, 1)
			writeTestBootstrapEnvelopeWithCapabilities(t, w, "gen-2", []string{CapabilitySnapshotFileMembershipV1})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
		Capabilities: []string{CapabilitySnapshotFileMembershipV1},
	})
	p.ExtendAdmissible([]string{"snapshots/gen-1/files/a.gz"})

	if err := p.authenticateAndSwap(); err != nil {
		t.Fatalf("authenticateAndSwap: %v", err)
	}
	if got := atomic.LoadInt32(&authCalls); got != 1 {
		t.Fatalf("authCalls = %d, want 1", got)
	}
	if !p.Admits("snapshots/gen-1/files/a.gz") {
		t.Fatal("admissible set must survive a session refresh")
	}
}

// TestDownloadSession_RefreshWithoutCapabilityReturnsDowngradeError proves
// that a refresh whose fresh descriptor drops
// snapshot-file-membership-v1 — a downgraded or misconfigured server — is
// refused rather than silently shrinking the admissible set (Task 9).
// TestRecoverySessionReauthTerminalNegotiationRefusalIsImmediate is the
// regression test for review finding #3 (w09-part0.md R5): a terminal 409
// from /bmr/recover/authenticate — capability_downgrade,
// storage_identity_drift, snapshot_storage_identity_unknown, or
// client_capability_required — is a *RecoveryNegotiationError, a distinct
// type from *authenticateStatusError. Before the fix,
// refreshAfterUnauthorized's terminal switch only matched
// *authenticateStatusError, so errors.As(err, &statusErr) was false for a
// negotiation error and isStatus's cases never matched — the reactive
// refresh retried it reauthMaxAttempts times with exponential backoff
// before finally giving up, instead of recognizing on the FIRST response
// that retrying cannot help. This proves: exactly one authenticate call,
// the session is marked lost, and the negotiation error/code survives the
// error chain via errors.As (and, for the capability_downgrade code
// specifically, errors.Is(err, ErrCapabilityDowngrade) is also true — the
// server-side and local capability-loss signals are the same condition).
func TestRecoverySessionReauthTerminalNegotiationRefusalIsImmediate(t *testing.T) {
	clock := newFakeClock()
	stopSleeps := withClockSleep(t, clock)
	defer stopSleeps()

	srv := newSessionFakeServer(t, clock)
	desc := srv.openSession(clock.Now().Add(-time.Minute)) // already expired: forces the reactive path
	p := srv.provider(clock, desc)
	p.membership = true // this token had already negotiated the capability

	srv.setAuthResponses(fakeAuthResponse{status: http.StatusConflict, message: "capability_downgrade"})

	errs := downloadN(t, p, 1)
	if errs[0] == nil {
		t.Fatal("expected an error")
	}
	if !errors.Is(errs[0], ErrRecoverySessionLost) {
		t.Fatalf("expected ErrRecoverySessionLost, got %v", errs[0])
	}
	if !errors.Is(errs[0], ErrCapabilityDowngrade) {
		t.Fatalf("expected errors.Is(err, ErrCapabilityDowngrade) = true, got %v", errs[0])
	}
	var negErr *RecoveryNegotiationError
	if !errors.As(errs[0], &negErr) {
		t.Fatalf("expected errors.As to find a *RecoveryNegotiationError in the chain, got %v", errs[0])
	}
	if negErr.Code != "capability_downgrade" {
		t.Fatalf("negErr.Code = %q, want capability_downgrade", negErr.Code)
	}

	authCalls, _, _ := srv.counts()
	if authCalls != 1 {
		t.Fatalf("authCalls = %d, want exactly 1 (a terminal 409 must not be retried)", authCalls)
	}
}

func TestDownloadSession_RefreshWithoutCapabilityReturnsDowngradeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/recover/authenticate") {
			// Simulate a server that stops granting the capability on
			// re-authenticate (e.g. downgraded/misconfigured server).
			writeTestBootstrapEnvelopeWithCapabilities(t, w, "gen-2", nil)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
		Capabilities: []string{CapabilitySnapshotFileMembershipV1},
	})
	beforeGen := p.sessionGeneration()

	err := p.authenticateAndSwap()
	if !errors.Is(err, ErrCapabilityDowngrade) {
		t.Fatalf("authenticateAndSwap error = %v, want ErrCapabilityDowngrade", err)
	}
	if got := p.sessionGeneration(); got != beforeGen {
		t.Fatalf("generation = %d, want unchanged %d (a rejected swap must not bump the generation)", got, beforeGen)
	}
	if !p.MembershipNegotiated() {
		t.Fatal("the previous descriptor's capability must be restored, not dropped")
	}
}

// #12566: the renewal credential a successful sign-in returned rides on every
// later authenticate, so the server counts the helper's renewals in their own
// allowance, and a rotated credential replaces the old one.
func TestRecoverySessionRenewalCarriesCredential(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	server.issueRenewal = "brz_rsr_second"
	p := server.provider(clock, server.openSession(clock.Now().Add(time.Hour)))
	p.setSessionRenewal("brz_rsr_first")

	clock.Advance(time.Hour - sessionRefreshLead + time.Minute)
	requireAllNil(t, downloadN(t, p, 2))
	clock.Advance(time.Hour - sessionRefreshLead)
	requireAllNil(t, downloadN(t, p, 2))

	if got := server.renewals(); fmt.Sprint(got) != fmt.Sprint([]string{"brz_rsr_first", "brz_rsr_second"}) {
		t.Fatalf("sessionRenewal sent = %q, want the bootstrap credential, then the refreshed one", got)
	}
}

// A server that predates the credential (or a provider built without one)
// sends no sessionRenewal field at all.
func TestRecoverySessionRenewalOmittedWithoutCredential(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	p := server.provider(clock, server.openSession(clock.Now().Add(-time.Second)))

	requireAllNil(t, downloadN(t, p, 1))
	if got := server.renewals(); fmt.Sprint(got) != fmt.Sprint([]string{""}) {
		t.Fatalf("sessionRenewal sent = %q, want the field absent", got)
	}
}

func TestNewRecoveryProviderKeepsBootstrapRenewalCredential(t *testing.T) {
	bs := &BootstrapResponse{
		Download:       &AuthenticatedDownloadDescriptor{Type: "breeze_proxy", URL: "https://example.invalid/download"},
		SessionRenewal: "brz_rsr_bootstrap",
	}
	provider, err := NewRecoveryProvider(context.Background(), "https://example.invalid", "brz_rec_test", bs)
	if err != nil {
		t.Fatalf("NewRecoveryProvider: %v", err)
	}
	p, ok := provider.(*recoveryDownloadProvider)
	if !ok {
		t.Fatalf("provider type = %T", provider)
	}
	if got := p.currentSessionRenewal(); got != "brz_rsr_bootstrap" {
		t.Fatalf("session renewal = %q, want the bootstrap credential", got)
	}
}

// #12566: the proactive refresh starts early enough that one refused renewal
// does not cost the session: it tries again, after the server's Retry-After,
// while the current session is still valid, and never blocks a download.
func TestRecoverySessionProactiveRefreshRetriesBeforeExpiry(t *testing.T) {
	clock := newFakeClock()
	sleeps := withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	server.setAuthResponses(
		fakeAuthResponse{status: http.StatusTooManyRequests, retryAfter: "300"},
		fakeAuthResponse{status: http.StatusTooManyRequests, retryAfter: "300"},
		fakeAuthResponse{status: http.StatusOK},
	)
	start := clock.Now()
	p := server.provider(clock, server.openSession(start.Add(time.Hour)))

	clock.Advance(time.Hour - sessionRefreshLead + time.Minute)
	for clock.Now().Before(start.Add(time.Hour + 10*time.Minute)) {
		requireAllNil(t, downloadN(t, p, 1))
		clock.Advance(time.Minute)
	}

	auth, _, unauthorized := server.counts()
	if auth != 3 || unauthorized != 0 {
		t.Fatalf("authenticate=%d unauthorized=%d, want 3 and 0 (two refusals, then a renewal before expiry)", auth, unauthorized)
	}
	if got := sleeps(); len(got) != 0 {
		t.Fatalf("proactive refresh must not block downloads; slept %v", got)
	}
}

// The proactive retries are bounded per expiry: a renewal that keeps being
// refused costs at most proactiveMaxAttempts calls before the session closes.
func TestRecoverySessionProactiveRetriesAreBounded(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	server.setAuthResponses(fakeAuthResponse{status: http.StatusTooManyRequests, retryAfter: "1"})
	start := clock.Now()
	p := server.provider(clock, server.openSession(start.Add(time.Hour)))

	clock.Advance(time.Hour - sessionRefreshLead)
	for clock.Now().Before(start.Add(time.Hour - time.Second)) {
		requireAllNil(t, downloadN(t, p, 1))
		clock.Advance(10 * time.Second)
	}
	if auth, _, _ := server.counts(); auth != proactiveMaxAttempts {
		t.Fatalf("proactive authenticate calls = %d, want %d", auth, proactiveMaxAttempts)
	}
}

func TestSessionRetryJitterIsBounded(t *testing.T) {
	for _, d := range []time.Duration{0, time.Second, 30 * time.Second, 5 * time.Minute} {
		for range 200 {
			got := sessionRetryJitter(d)
			if got < d || got > d+d/5 {
				t.Fatalf("sessionRetryJitter(%v) = %v, want within [d, 1.2d]", d, got)
			}
		}
	}
}

// #12566: when the session is finally lost, the restore says how to finish,
// and nothing already restored is removed.
func TestRestoreFilesSessionLostSaysHowToResume(t *testing.T) {
	restoreRoot := t.TempDir()
	provider := &breakerFakeProvider{
		downloadErr: func(idx int) error {
			if idx < 2 {
				return nil
			}
			return fmt.Errorf("%w: re-authenticate still rate-limited", ErrRecoverySessionLost)
		},
	}
	files := make([]manifestFile, 5)
	for i := range files {
		files[i] = manifestFile{
			SourcePath: filepath.Join(restoreRoot, fmt.Sprintf("f%d", i)),
			BackupPath: path.Join("snapshots", "resume-hint", "files", fmt.Sprintf("f%d.gz", i)),
			Size:       10,
		}
	}
	manifest := &snapshotManifest{ID: "resume-hint", Files: files, Size: 50}

	_, _, warnings, _, err := restoreFiles(context.Background(), manifest, nil, RecoveryConfig{}, provider)
	if !errors.Is(err, ErrRecoverySessionLost) {
		t.Fatalf("err = %v, want ErrRecoverySessionLost", err)
	}
	for _, text := range []string{err.Error(), strings.Join(warnings, "\n")} {
		if !strings.Contains(text, "create a new recovery token") {
			t.Fatalf("%q does not say how to resume", text)
		}
		if !strings.Contains(text, "stay in place") {
			t.Fatalf("%q does not say restored files are kept", text)
		}
	}
}

// A refused renewal keeps the credential it had and sends it again.
func TestRecoverySessionRefusedRenewalKeepsCredential(t *testing.T) {
	clock := newFakeClock()
	withClockSleep(t, clock)
	server := newSessionFakeServer(t, clock)
	server.issueRenewal = "brz_rsr_second"
	server.setAuthResponses(
		fakeAuthResponse{status: http.StatusTooManyRequests, retryAfter: "30"},
		fakeAuthResponse{status: http.StatusOK},
	)
	p := server.provider(clock, server.openSession(clock.Now().Add(-time.Second)))
	p.setSessionRenewal("brz_rsr_first")

	requireAllNil(t, downloadN(t, p, 1))
	if got := server.renewals(); fmt.Sprint(got) != fmt.Sprint([]string{"brz_rsr_first", "brz_rsr_first"}) {
		t.Fatalf("sessionRenewal sent = %q, want the same credential on the retry", got)
	}
	if got := p.currentSessionRenewal(); got != "brz_rsr_second" {
		t.Fatalf("credential after a successful renewal = %q, want the server's new one", got)
	}
}

// Cancelling while waiting out a 429 ends the wait without marking the
// session lost: a user cancel is not a server refusal.
func TestRecoverySessionCancelDuringRateLimitWait(t *testing.T) {
	clock := newFakeClock()
	server := newSessionFakeServer(t, clock)
	server.setAuthResponses(fakeAuthResponse{status: http.StatusTooManyRequests, retryAfter: "120"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	orig := retrySleep
	retrySleep = func(ctx context.Context, d time.Duration) error {
		cancel()
		return ctx.Err()
	}
	t.Cleanup(func() { retrySleep = orig })

	desc := server.openSession(clock.Now().Add(-time.Second))
	p := newRecoveryDownloadProvider(ctx, server.srv.URL, "brz_rec_test", desc)
	p.now = clock.Now
	p.lastAuthAt = clock.Now()

	err := p.Download("snapshots/snap-1/f0", filepath.Join(t.TempDir(), "f0"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if errors.Is(err, ErrRecoverySessionLost) || p.sessionLost() != nil {
		t.Fatalf("cancellation must not mark the session lost (err=%v, lost=%v)", err, p.sessionLost())
	}
}

// 429s do not use up the attempts a pending file index gets, and pending
// answers do not use up the 429 budget: each keeps its own bound.
func TestRecoverySessionPendingAndRateLimitKeepSeparateBounds(t *testing.T) {
	pending := fakeAuthResponse{status: http.StatusConflict, message: "snapshot_index_pending"}
	tooMany := fakeAuthResponse{status: http.StatusTooManyRequests, retryAfter: "5"}
	ok := fakeAuthResponse{status: http.StatusOK}

	t.Run("interleaved, then success", func(t *testing.T) {
		clock := newFakeClock()
		withClockSleep(t, clock)
		server := newSessionFakeServer(t, clock)
		server.setAuthResponses(pending, tooMany, pending, tooMany, pending, tooMany, pending, ok)
		p := server.provider(clock, server.openSession(clock.Now().Add(-time.Second)))

		requireAllNil(t, downloadN(t, p, 1))
		if auth, _, _ := server.counts(); auth != 8 {
			t.Fatalf("authenticate calls = %d, want 8", auth)
		}
	})

	t.Run("pending still ends after reauthMaxAttempts", func(t *testing.T) {
		clock := newFakeClock()
		withClockSleep(t, clock)
		server := newSessionFakeServer(t, clock)
		server.setAuthResponses(tooMany, pending, tooMany, pending, pending, pending, pending)
		p := server.provider(clock, server.openSession(clock.Now().Add(-time.Second)))

		err := downloadN(t, p, 1)[0]
		if !errors.Is(err, ErrRecoverySessionLost) || !strings.Contains(err.Error(), "still pending after") {
			t.Fatalf("err = %v, want a lost session after the pending attempts", err)
		}
		if auth, _, _ := server.counts(); auth != 2+reauthMaxAttempts {
			t.Fatalf("authenticate calls = %d, want %d (two 429s plus the pending cap)", auth, 2+reauthMaxAttempts)
		}
	})
}

// The token-driven run hands the bootstrap's credential to the download
// provider it builds, so the helper's renewals carry it from the start.
func TestRunRecoveryWithTokenWiresSessionRenewal(t *testing.T) {
	origRunRecovery := runRecovery
	defer func() { runRecovery = origRunRecovery }()
	var gotRenewal string
	runRecovery = func(ctx context.Context, cfg RecoveryConfig, provider providers.BackupProvider) (*RecoveryResult, error) {
		if p, ok := provider.(*recoveryDownloadProvider); ok {
			gotRenewal = p.currentSessionRenewal()
		}
		return &RecoveryResult{Status: "completed"}, nil
	}

	var srvURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/backup/bmr/recover/authenticate":
			_ = json.NewEncoder(w).Encode(map[string]any{"bootstrap": BootstrapResponse{
				Version:    BootstrapResponseVersion,
				TokenID:    "token-1",
				DeviceID:   "device-1",
				SnapshotID: "db-snapshot-1",
				Snapshot:   &AuthenticatedSnapshot{ID: "db-snapshot-1", SnapshotID: "snap-1"},
				Download: &AuthenticatedDownloadDescriptor{
					Type: "breeze_proxy", URL: srvURL + "/download", PathQueryParam: "path",
					TokenHeaderName: "authorization", TokenHeaderFormat: "Bearer <recovery-token>",
					PathPrefix: "snapshots/snap-1",
				},
				SessionRenewal: "brz_rsr_run",
			}})
		case "/api/v1/backup/bmr/recover/complete":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	srvURL = server.URL

	if _, err := RunRecoveryWithTokenContext(context.Background(), RecoveryConfig{RecoveryToken: "brz_rec_test", ServerURL: server.URL}); err != nil {
		t.Fatalf("RunRecoveryWithTokenContext: %v", err)
	}
	if gotRenewal != "brz_rsr_run" {
		t.Fatalf("download provider session renewal = %q, want the bootstrap's credential", gotRenewal)
	}
}
