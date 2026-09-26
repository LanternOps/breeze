package watchdog

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/authstate"
)

type authFakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *authFakeClock) Now() time.Time          { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *authFakeClock) Advance(d time.Duration) { c.mu.Lock(); c.now = c.now.Add(d); c.mu.Unlock() }

// authServer answers every request with the current status and counts hits.
func authServer(t *testing.T, status *atomic.Int32) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		code := int(status.Load())
		w.WriteHeader(code)
		if code == http.StatusOK {
			if strings.HasSuffix(r.URL.Path, "/heartbeat") {
				w.Write([]byte(`{}`)) //nolint:errcheck
			} else {
				w.Write([]byte(`{"commands":[]}`)) //nolint:errcheck
			}
			return
		}
		w.Write([]byte(`{"error":"Invalid agent credentials"}`)) //nolint:errcheck
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// #2796 defect B: a watchdog in FAILOVER for a deauthorized device POSTed the
// heartbeat every FailoverPollInterval (30s → 2880/day) forever. Rejections
// must back the client off exponentially; skipped ticks must send nothing.
func TestFailoverHeartbeatBacksOffOnAuthRejection(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			var status atomic.Int32
			status.Store(int32(code))
			srv, hits := authServer(t, &status)
			clk := &authFakeClock{now: time.Unix(9_000_000, 0)}

			fc := NewFailoverClient(srv.URL, "agent-1", "tok", nil)
			fc.SetAuthMonitor(NewFailoverAuthMonitor(authstate.WithClock(clk.Now)))

			// Simulate 24h of 30s failover ticks.
			for tick := 0; tick < 2880; tick++ {
				_, err := fc.SendHeartbeat("1.0.0", "failover", RestartStats{})
				if err == nil {
					t.Fatal("heartbeat succeeded against a rejecting server")
				}
				if !errors.Is(err, ErrAuthBackoff) && !IsAuthRejected(err) {
					t.Fatalf("tick %d: err %v is neither an auth rejection nor an auth-backoff skip", tick, err)
				}
				clk.Advance(30 * time.Second)
			}
			// Cap is 30m → ≤ 48/day at steady state plus the ramp.
			if got := hits.Load(); got > 80 {
				t.Fatalf("watchdog sent %d heartbeats in 24h against a %d server — no effective auth backoff", got, code)
			}
			if got := hits.Load(); got < 40 {
				t.Fatalf("watchdog sent only %d heartbeats in 24h — the ceiling is too high to ever self-heal promptly", got)
			}
		})
	}
}

func TestFailoverAuthBackoffSkipsPollAndSelfHeals(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusUnauthorized)
	srv, hits := authServer(t, &status)
	clk := &authFakeClock{now: time.Unix(9_500_000, 0)}

	fc := NewFailoverClient(srv.URL, "agent-1", "tok", nil)
	fc.SetAuthMonitor(NewFailoverAuthMonitor(authstate.WithClock(clk.Now)))

	for i := 0; i < failoverAuthThreshold; i++ {
		if _, err := fc.SendHeartbeat("1.0.0", "failover", RestartStats{}); !IsAuthRejected(err) {
			t.Fatalf("rejection %d: err = %v, want an auth rejection", i, err)
		}
	}
	before := hits.Load()
	if _, err := fc.SendHeartbeat("1.0.0", "failover", RestartStats{}); !errors.Is(err, ErrAuthBackoff) {
		t.Fatalf("heartbeat inside the backoff window: err = %v, want ErrAuthBackoff", err)
	}
	if _, err := fc.PollCommands(); !errors.Is(err, ErrAuthBackoff) {
		t.Fatalf("poll inside the backoff window: err = %v, want ErrAuthBackoff", err)
	}
	if hits.Load() != before {
		t.Fatal("a request reached the server during the auth backoff window")
	}
	if fc.AuthRetryIn() <= 0 {
		t.Fatal("AuthRetryIn() = 0 inside the backoff window")
	}

	// Credentials fixed server-side (device re-approved): the next retry past
	// the window succeeds and the client returns to normal cadence.
	status.Store(http.StatusOK)
	clk.Advance(failoverAuthInitialBackoff * 2)
	if _, err := fc.SendHeartbeat("1.0.0", "failover", RestartStats{}); err != nil {
		t.Fatalf("retry after the window: %v", err)
	}
	if _, err := fc.SendHeartbeat("1.0.0", "failover", RestartStats{}); err != nil {
		t.Fatalf("heartbeat after recovery: %v", err)
	}
	if fc.AuthRetryIn() != 0 {
		t.Fatal("AuthRetryIn() nonzero after recovery")
	}
}

// A 5xx or transport failure is not an auth rejection: it must not arm the
// auth backoff (the existing backup-URL failover logic owns that case).
func TestFailoverServerErrorDoesNotArmAuthBackoff(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusInternalServerError)
	srv, hits := authServer(t, &status)
	fc := NewFailoverClient(srv.URL, "agent-1", "tok", nil)
	for i := 0; i < 10; i++ {
		_, err := fc.SendHeartbeat("1.0.0", "failover", RestartStats{})
		if err == nil || errors.Is(err, ErrAuthBackoff) || IsAuthRejected(err) {
			t.Fatalf("call %d: err = %v, want a plain non-auth failure", i, err)
		}
	}
	if hits.Load() != 10 {
		t.Fatalf("hits = %d, want 10", hits.Load())
	}
}

// Advisor quorum (#2796): a rotated token must reach the live failover
// client and end a backoff earned by the OLD credential, or a valid new
// token waits out up to 30 minutes of someone else's penalty.
func TestFailoverUpdateTokenResetsAuthBackoff(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusUnauthorized)
	var lastAuth atomic.Value
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		lastAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(int(status.Load()))
		w.Write([]byte(`{}`)) //nolint:errcheck
	}))
	defer srv.Close()

	fc := NewFailoverClient(srv.URL, "agent-1", "old", nil)
	for i := 0; i < failoverAuthThreshold; i++ {
		_, _ = fc.SendHeartbeat("v", "failover", RestartStats{})
	}
	if _, err := fc.SendHeartbeat("v", "failover", RestartStats{}); !errors.Is(err, ErrAuthBackoff) {
		t.Fatalf("setup: err = %v, want ErrAuthBackoff", err)
	}

	status.Store(http.StatusOK)
	fc.UpdateToken("new")
	if _, err := fc.SendHeartbeat("v", "failover", RestartStats{}); err != nil {
		t.Fatalf("heartbeat right after token update: %v", err)
	}
	if got, _ := lastAuth.Load().(string); got != "Bearer new" {
		t.Fatalf("Authorization = %q, want the rotated token", got)
	}
}
