package workspaceindex

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// #12713: a 503 (extension loaded but disabled) or 403 (device parked,
// quarantined or draining) from crawl-config must not be retried every tick.

const crawlConfigPath = "/api/v1/workspace/agent/agent-1/crawl-config"

// crawlConfigResponder answers crawl-config with the status (and optional
// Retry-After) currently stored, counting every fetch.
type crawlConfigResponder struct {
	t          *testing.T
	status     atomic.Int32
	retryAfter atomic.Value // string
	fetches    atomic.Int32
}

func newCrawlConfigResponder(t *testing.T, status int, retryAfter string) *crawlConfigResponder {
	r := &crawlConfigResponder{t: t}
	r.status.Store(int32(status))
	r.retryAfter.Store(retryAfter)
	return r
}

func (r *crawlConfigResponder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet || req.URL.Path != crawlConfigPath {
		r.t.Errorf("unexpected request: %s %s", req.Method, req.URL.Path)
		w.WriteHeader(http.StatusNotFound)
		return
	}
	r.fetches.Add(1)
	status := int(r.status.Load())
	if status == http.StatusOK {
		writeLoopConfig(r.t, w, CrawlConfig{Enabled: true, PollIntervalSeconds: 60})
		return
	}
	if ra, _ := r.retryAfter.Load().(string); ra != "" {
		w.Header().Set("Retry-After", ra)
	}
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":"extension unavailable"}`))
}

// clockedLoop is a running loop with a test-controlled clock and a 1 ms tick,
// so "did it refetch?" depends only on the clock.
type clockedLoop struct {
	nowNanos atomic.Int64
	// nowCalls counts clock reads; the loop reads the clock once per tick.
	nowCalls atomic.Int64
}

func (l *clockedLoop) Store(nanos int64) { l.nowNanos.Store(nanos) }

func startClockedLoop(t *testing.T, responder http.Handler, base time.Time) *clockedLoop {
	return startClockedLoopWithLog(t, responder, base, loopTestLogger())
}

func startClockedLoopWithLog(t *testing.T, responder http.Handler, base time.Time, log *slog.Logger) *clockedLoop {
	t.Helper()
	loop := &clockedLoop{}
	loop.nowNanos.Store(base.UnixNano())

	ctx, cancel := context.WithCancel(context.Background())
	done := StartLoop(ctx, Deps{
		Client: newTestClient(t, responder),
		Log:    log,
		Now: func() time.Time {
			loop.nowCalls.Add(1)
			return time.Unix(0, loop.nowNanos.Load())
		},
		TickInterval: time.Millisecond,
	})
	t.Cleanup(func() {
		cancel()
		waitLoopSignal(t, done, "loop shutdown")
	})
	return loop
}

// assertFetchCountHolds waits until the loop has evaluated several ticks at
// the current clock, then checks it did not fetch again. Counting clock reads
// (not sleeping) keeps the check from passing vacuously on a starved host.
func assertFetchCountHolds(t *testing.T, loop *clockedLoop, fetches *atomic.Int32, want int32, when string) {
	t.Helper()
	start := loop.nowCalls.Load()
	waitLoopCondition(t, func() bool { return loop.nowCalls.Load() >= start+5 }, "loop ticks at "+when)
	if got := fetches.Load(); got != want {
		t.Fatalf("fetches %s = %d, want %d", when, got, want)
	}
}

func TestStartLoopUnavailableBacksOffInsteadOfRetryingEachTick(t *testing.T) {
	for _, status := range []int{http.StatusServiceUnavailable, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			base := time.Date(2026, time.November, 25, 0, 0, 0, 0, time.UTC)
			responder := newCrawlConfigResponder(t, status, "")
			now := startClockedLoop(t, responder, base)

			waitLoopCondition(t, func() bool { return responder.fetches.Load() == 1 }, "initial fetch")

			// Without Retry-After the earliest refetch is unavailableBackoffMin.
			now.Store(base.Add(2 * time.Minute).UnixNano())
			assertFetchCountHolds(t, now, &responder.fetches, 1, "two minutes after an unavailable response")
			now.Store(base.Add(unavailableBackoffMin - time.Second).UnixNano())
			assertFetchCountHolds(t, now, &responder.fetches, 1, "just before the back-off floor")

			// ...and the latest is unavailableBackoffMax.
			now.Store(base.Add(unavailableBackoffMax + time.Second).UnixNano())
			waitLoopCondition(t, func() bool { return responder.fetches.Load() >= 2 }, "fetch after the back-off")
			if got := responder.fetches.Load(); got != 2 {
				t.Fatalf("fetches after back-off = %d, want 2", got)
			}
		})
	}
}

func TestStartLoopUnavailableHonoursRetryAfter(t *testing.T) {
	base := time.Date(2026, time.November, 25, 0, 0, 0, 0, time.UTC)
	responder := newCrawlConfigResponder(t, http.StatusServiceUnavailable, "7200")
	now := startClockedLoop(t, responder, base)

	waitLoopCondition(t, func() bool { return responder.fetches.Load() == 1 }, "initial fetch")

	// Past the no-header ceiling, still inside the server's two hours.
	now.Store(base.Add(2*time.Hour - time.Second).UnixNano())
	assertFetchCountHolds(t, now, &responder.fetches, 1, "before Retry-After elapsed")

	// Two hours plus the at-most-10% jitter.
	now.Store(base.Add(2*time.Hour + 12*time.Minute + time.Second).UnixNano())
	waitLoopCondition(t, func() bool { return responder.fetches.Load() >= 2 }, "fetch after Retry-After")
}

func TestStartLoopRecoversToNormalCadenceAfterUnavailable(t *testing.T) {
	base := time.Date(2026, time.November, 25, 0, 0, 0, 0, time.UTC)
	responder := newCrawlConfigResponder(t, http.StatusServiceUnavailable, "")
	now := startClockedLoop(t, responder, base)

	waitLoopCondition(t, func() bool { return responder.fetches.Load() == 1 }, "initial fetch")

	// The server comes back; the next fetch after the back-off succeeds.
	responder.status.Store(http.StatusOK)
	recovered := base.Add(unavailableBackoffMax + time.Second)
	now.Store(recovered.UnixNano())
	waitLoopCondition(t, func() bool { return responder.fetches.Load() == 2 }, "fetch after back-off")

	// From here the server's poll interval (60 s, jittered ±10%) drives the
	// cadence again: no restart, no lingering back-off.
	now.Store(recovered.Add(67 * time.Second).UnixNano())
	waitLoopCondition(t, func() bool { return responder.fetches.Load() == 3 }, "fetch on the normal cadence")
}

// Errors outside the unavailable set keep the one-tick retry.
func TestStartLoopOtherErrorsStillRetryNextTick(t *testing.T) {
	base := time.Date(2026, time.November, 25, 0, 0, 0, 0, time.UTC)
	responder := newCrawlConfigResponder(t, http.StatusInternalServerError, "")
	now := startClockedLoop(t, responder, base)

	waitLoopCondition(t, func() bool { return responder.fetches.Load() == 1 }, "initial fetch")
	now.Store(base.Add(time.Second).UnixNano())
	waitLoopCondition(t, func() bool { return responder.fetches.Load() >= 2 }, "retry on the next tick")
}

func TestUnavailableBackoffWithoutRetryAfterIsJitteredWithinWindow(t *testing.T) {
	seen := map[time.Duration]bool{}
	for range 2000 {
		got := unavailableBackoff(0)
		if got < unavailableBackoffMin || got > unavailableBackoffMax {
			t.Fatalf("unavailableBackoff(0) = %v, want within [%v, %v]", got, unavailableBackoffMin, unavailableBackoffMax)
		}
		seen[got] = true
	}
	if len(seen) < 100 {
		t.Fatalf("unavailableBackoff(0) produced %d distinct values in 2000 draws; jitter is not spreading the fleet", len(seen))
	}
}

// The gateway sends every agent the same Retry-After, so the jitter on the
// hinted path is what keeps a fleet from returning in the same second.
func TestUnavailableBackoffWithRetryAfterIsJittered(t *testing.T) {
	hint := 30 * time.Minute
	seen := map[time.Duration]bool{}
	for range 2000 {
		seen[unavailableBackoff(hint)] = true
	}
	if len(seen) < 100 {
		t.Fatalf("unavailableBackoff(%v) produced %d distinct values in 2000 draws, want >= 100", hint, len(seen))
	}
}

// levelRecorder is a slog.Handler that keeps the level of each record whose
// message matches.
type levelRecorder struct {
	mu      sync.Mutex
	message string
	levels  []slog.Level
}

func (r *levelRecorder) Enabled(context.Context, slog.Level) bool { return true }
func (r *levelRecorder) WithAttrs([]slog.Attr) slog.Handler       { return r }
func (r *levelRecorder) WithGroup(string) slog.Handler            { return r }
func (r *levelRecorder) Handle(_ context.Context, rec slog.Record) error {
	if rec.Message == r.message {
		r.mu.Lock()
		r.levels = append(r.levels, rec.Level)
		r.mu.Unlock()
	}
	return nil
}

func (r *levelRecorder) snapshot() []slog.Level {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.levels)
}

// A fleet with the module off must not ship a Warn per agent per back-off:
// only entering the state, or a change of status, is shipped.
func TestStartLoopUnavailableWarnsOnTransitionOnly(t *testing.T) {
	base := time.Date(2026, time.November, 25, 0, 0, 0, 0, time.UTC)
	recorder := &levelRecorder{message: "workspace index unavailable; backing off config poll"}
	responder := newCrawlConfigResponder(t, http.StatusServiceUnavailable, "")
	now := startClockedLoopWithLog(t, responder, base, slog.New(recorder))

	step := func(at time.Duration, fetches int32) {
		t.Helper()
		now.Store(base.Add(at).UnixNano())
		waitLoopCondition(t, func() bool { return responder.fetches.Load() == fetches }, fmt.Sprintf("fetch %d", fetches))
	}
	waitLoopCondition(t, func() bool { return responder.fetches.Load() == 1 }, "initial fetch")
	step(1*time.Hour+time.Second, 2) // same 503 again
	responder.status.Store(http.StatusForbidden)
	step(2*time.Hour+2*time.Second, 3) // status changed to 403
	responder.status.Store(http.StatusOK)
	step(3*time.Hour+3*time.Second, 4) // recovered
	responder.status.Store(http.StatusServiceUnavailable)
	step(3*time.Hour+3*time.Second+67*time.Second, 5) // unavailable again

	want := []slog.Level{slog.LevelWarn, slog.LevelDebug, slog.LevelWarn, slog.LevelWarn}
	waitLoopCondition(t, func() bool { return len(recorder.snapshot()) == len(want) }, "back-off log records")
	if got := recorder.snapshot(); !slices.Equal(got, want) {
		t.Fatalf("back-off log levels = %v, want %v", got, want)
	}
}

func TestUnavailableBackoffRetryAfterBounds(t *testing.T) {
	tests := []struct {
		name       string
		retryAfter time.Duration
		min, max   time.Duration
	}{
		{name: "below floor is raised to one minute", retryAfter: 5 * time.Second, min: time.Minute, max: time.Minute + 6*time.Second},
		{name: "in range is honoured plus at most 10%", retryAfter: 2 * time.Hour, min: 2 * time.Hour, max: 2*time.Hour + 12*time.Minute},
		{name: "above ceiling is held at six hours", retryAfter: 24 * time.Hour, min: 6 * time.Hour, max: 6 * time.Hour},
		{name: "jitter never crosses the ceiling", retryAfter: 5*time.Hour + 50*time.Minute, min: 5*time.Hour + 50*time.Minute, max: 6 * time.Hour},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for range 500 {
				got := unavailableBackoff(tt.retryAfter)
				if got < tt.min || got > tt.max {
					t.Fatalf("unavailableBackoff(%v) = %v, want within [%v, %v]", tt.retryAfter, got, tt.min, tt.max)
				}
			}
		})
	}
}

func TestFetchConfigClassifiesUnavailableAndParsesRetryAfter(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	tests := []struct {
		name            string
		status          int
		retryAfter      string
		wantUnavailable bool
		wantRetryAfter  time.Duration
		tolerance       time.Duration
	}{
		{name: "503 seconds form", status: http.StatusServiceUnavailable, retryAfter: "1800", wantUnavailable: true, wantRetryAfter: 30 * time.Minute},
		{name: "503 HTTP-date form", status: http.StatusServiceUnavailable, retryAfter: now.Add(2 * time.Hour).Format(http.TimeFormat), wantUnavailable: true, wantRetryAfter: 2 * time.Hour, tolerance: 5 * time.Second},
		{name: "503 above ceiling", status: http.StatusServiceUnavailable, retryAfter: "86400", wantUnavailable: true, wantRetryAfter: unavailableRetryAfterCeiling},
		{name: "503 malformed header", status: http.StatusServiceUnavailable, retryAfter: "later", wantUnavailable: true},
		{name: "503 no header", status: http.StatusServiceUnavailable, wantUnavailable: true},
		{name: "403 parked device", status: http.StatusForbidden, wantUnavailable: true},
		{name: "500 is not unavailable", status: http.StatusInternalServerError},
		{name: "401 is not unavailable", status: http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, newCrawlConfigResponder(t, tt.status, tt.retryAfter))
			_, err := client.FetchConfig(context.Background())
			if err == nil {
				t.Fatal("FetchConfig() error = nil")
			}
			if got := errors.Is(err, ErrUnavailable); got != tt.wantUnavailable {
				t.Fatalf("errors.Is(err, ErrUnavailable) = %v, want %v (err: %v)", got, tt.wantUnavailable, err)
			}
			if errors.Is(err, ErrModuleAbsent) {
				t.Fatalf("status %d classified as module absent: %v", tt.status, err)
			}
			httpErr, ok := errors.AsType[*HTTPError](err)
			if !ok {
				t.Fatalf("error %v does not carry *HTTPError", err)
			}
			if httpErr.StatusCode != tt.status {
				t.Fatalf("StatusCode = %d, want %d", httpErr.StatusCode, tt.status)
			}
			if diff := httpErr.RetryAfter - tt.wantRetryAfter; diff < -tt.tolerance || diff > tt.tolerance {
				t.Fatalf("RetryAfter = %v, want %v (±%v)", httpErr.RetryAfter, tt.wantRetryAfter, tt.tolerance)
			}
		})
	}
}

// The back-off must not change what the shared auth monitor counts: a 503 or
// 403 is not an auth failure, a 401 still is.
func TestFetchConfigUnavailableIsNotAnAuthFailure(t *testing.T) {
	for _, tt := range []struct {
		status   int
		wantSkip bool
	}{
		{status: http.StatusServiceUnavailable, wantSkip: false},
		{status: http.StatusForbidden, wantSkip: false},
		{status: http.StatusUnauthorized, wantSkip: true},
	} {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			monitor := authstate.NewMonitor(1)
			serverURL, httpClient := newHTTPTestEndpoint(newCrawlConfigResponder(t, tt.status, "60"), "server.test")
			token := secmem.NewSecureString("agent-secret")
			t.Cleanup(token.Zero)
			client := NewClient(ClientConfig{
				ServerURL:   func() string { return serverURL },
				AgentID:     "agent-1",
				AuthToken:   token,
				HTTPClient:  httpClient,
				AuthMonitor: monitor,
			})
			if _, err := client.FetchConfig(context.Background()); err == nil {
				t.Fatal("FetchConfig() error = nil")
			}
			if got := monitor.ShouldSkip(); got != tt.wantSkip {
				t.Fatalf("auth monitor ShouldSkip() after %d = %v, want %v", tt.status, got, tt.wantSkip)
			}
		})
	}
}
