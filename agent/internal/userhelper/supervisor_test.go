package userhelper

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSupervisedClient is a scripted SupervisedClient. Each Run() pops the
// next entry from results; Stop() records that it was called and unblocks a
// Run that is parked on blockUntilStop.
type fakeSupervisedClient struct {
	mu sync.Mutex

	err      error
	authAt   time.Time
	stopped  bool
	stopChan chan struct{}
	// block makes Run() wait for Stop() (or for the test to close stopChan)
	// so shutdown-while-running can be exercised deterministically.
	block bool
}

func (f *fakeSupervisedClient) Run() error {
	if f.block {
		<-f.stopChan
	}
	return f.err
}

func (f *fakeSupervisedClient) Stop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stopped {
		return
	}
	f.stopped = true
	close(f.stopChan)
}

func (f *fakeSupervisedClient) AuthenticatedAt() time.Time { return f.authAt }

func (f *fakeSupervisedClient) wasStopped() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stopped
}

func newFakeClient(err error, authAt time.Time) *fakeSupervisedClient {
	return &fakeSupervisedClient{err: err, authAt: authAt, stopChan: make(chan struct{})}
}

// testSupervisor wires a Supervisor whose clients come from the given script
// and whose sleeps are recorded instead of actually waiting.
type supervisorHarness struct {
	sup     *Supervisor
	waits   []time.Duration
	clients []*fakeSupervisedClient
	now     time.Time
}

// newHarness builds a supervisor that hands out the scripted clients in
// order. Once the script is exhausted the supervisor is told to shut down so
// tests can never spin forever.
func newHarness(t *testing.T, policy ReconnectPolicy, script []*fakeSupervisedClient) (*supervisorHarness, chan struct{}) {
	t.Helper()
	done := make(chan struct{})
	h := &supervisorHarness{now: time.Unix(1_700_000_000, 0).UTC()}
	idx := 0
	h.sup = &Supervisor{
		Name:   "test helper",
		Policy: policy,
		NewClient: func() SupervisedClient {
			if idx >= len(script) {
				// Script exhausted: signal shutdown and hand back a client
				// that returns immediately so Run() unwinds.
				select {
				case <-done:
				default:
					close(done)
				}
				c := newFakeClient(nil, time.Time{})
				h.clients = append(h.clients, c)
				return c
			}
			c := script[idx]
			idx++
			h.clients = append(h.clients, c)
			return c
		},
		now: func() time.Time { return h.now },
		// Deterministic: always take the top of the jitter range so the
		// recorded wait is exactly backoff + backoff/2. The supervisor asks
		// for rand.Int64N(backoff/2 + 1), which yields [0, backoff/2], so
		// the largest legal draw is n-1.
		jitter: func(n int64) int64 { return max(n-1, 0) },
		sleep: func(d time.Duration, done <-chan struct{}) bool {
			h.waits = append(h.waits, d)
			select {
			case <-done:
				return false
			default:
				return true
			}
		},
	}
	return h, done
}

func testPolicy() ReconnectPolicy {
	return ReconnectPolicy{
		MinBackoff:      1 * time.Second,
		MaxBackoff:      8 * time.Second,
		StableThreshold: 60 * time.Second,
		WarnLimit:       3,
		WarnWindow:      5 * time.Minute,
	}
}

func TestSupervisorRetriesTransientErrorsWithExponentialBackoff(t *testing.T) {
	transient := errors.New("recv: EOF")
	script := []*fakeSupervisedClient{
		newFakeClient(transient, time.Time{}),
		newFakeClient(transient, time.Time{}),
		newFakeClient(transient, time.Time{}),
		newFakeClient(transient, time.Time{}),
		newFakeClient(transient, time.Time{}),
	}
	h, done := newHarness(t, testPolicy(), script)

	res := h.sup.Run(done)

	if res.Reason != StopShutdown {
		t.Fatalf("expected StopShutdown after script exhausted, got %v (err=%v)", res.Reason, res.Err)
	}
	// jitter is pinned to the top of the range, so wait = backoff * 1.5 and
	// backoff doubles after each completed sleep, capped at MaxBackoff (8s).
	want := []time.Duration{
		1500 * time.Millisecond, // backoff 1s
		3 * time.Second,         // backoff 2s
		6 * time.Second,         // backoff 4s
		12 * time.Second,        // backoff 8s (cap)
		12 * time.Second,        // backoff stays at cap
	}
	if len(h.waits) != len(want) {
		t.Fatalf("expected %d backoff sleeps, got %d: %v", len(want), len(h.waits), h.waits)
	}
	for i := range want {
		if h.waits[i] != want[i] {
			t.Errorf("wait[%d] = %v, want %v (all waits: %v)", i, h.waits[i], want[i], h.waits)
		}
	}
	// A fresh client must be constructed for every attempt — Client.stopChan
	// is closed by Stop() and never reopened, so reusing one is a latent bug.
	if len(h.clients) != len(script)+1 {
		t.Errorf("expected %d clients constructed, got %d", len(script)+1, len(h.clients))
	}
	for i, c := range h.clients {
		for j, other := range h.clients {
			if i != j && c == other {
				t.Fatalf("client reused between attempts %d and %d", i, j)
			}
		}
	}
}

func TestSupervisorResetsBackoffOnlyAfterStableAuth(t *testing.T) {
	transient := errors.New("recv: connection reset")
	fixedNow := time.Unix(1_700_000_000, 0).UTC()

	// Attempt 1+2 never authenticate: backoff climbs 1s -> 2s.
	// Attempt 3 authenticated 90s ago (> 60s stable threshold): backoff resets.
	// Attempt 4 authenticated 5s ago (< threshold): no reset, backoff climbs.
	script := []*fakeSupervisedClient{
		newFakeClient(transient, time.Time{}),
		newFakeClient(transient, time.Time{}),
		newFakeClient(transient, fixedNow.Add(-90*time.Second)),
		newFakeClient(transient, fixedNow.Add(-5*time.Second)),
	}
	h, done := newHarness(t, testPolicy(), script)
	h.now = fixedNow

	res := h.sup.Run(done)
	if res.Reason != StopShutdown {
		t.Fatalf("expected StopShutdown, got %v", res.Reason)
	}

	want := []time.Duration{
		1500 * time.Millisecond, // attempt 1: backoff 1s (min)
		3 * time.Second,         // attempt 2: backoff 2s
		1500 * time.Millisecond, // attempt 3: stable auth -> reset to 1s
		3 * time.Second,         // attempt 4: auth too recent -> climbs to 2s
	}
	if len(h.waits) != len(want) {
		t.Fatalf("expected %d sleeps, got %d: %v", len(want), len(h.waits), h.waits)
	}
	for i := range want {
		if h.waits[i] != want[i] {
			t.Errorf("wait[%d] = %v, want %v (all: %v)", i, h.waits[i], want[i], h.waits)
		}
	}
}

func TestSupervisorStopsImmediatelyOnFatalError(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{
			name: "permanent reject",
			err:  &PermanentRejectError{Code: "binary_path_unknown", Reason: "unknown binary"},
		},
		{
			name: "permanent reject wrapped",
			err:  fmt.Errorf("authenticate: %w", &PermanentRejectError{Code: "sid_mismatch", Reason: "nope"}),
		},
		{
			name: "sid lookup failed",
			err:  fmt.Errorf("authenticate: %w", ErrSIDLookupFailed),
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			script := []*fakeSupervisedClient{newFakeClient(tc.err, time.Time{})}
			h, done := newHarness(t, testPolicy(), script)

			res := h.sup.Run(done)

			if res.Reason != StopFatal {
				t.Fatalf("expected StopFatal, got %v", res.Reason)
			}
			if !errors.Is(res.Err, tc.err) && res.Err.Error() != tc.err.Error() {
				t.Errorf("expected the fatal error to be returned, got %v", res.Err)
			}
			if len(h.waits) != 0 {
				t.Errorf("fatal error must not sleep a backoff, got %v", h.waits)
			}
			if len(h.clients) != 1 {
				t.Errorf("fatal error must not retry, got %d clients", len(h.clients))
			}
		})
	}
}

func TestSupervisorTreatsNilRunErrorAsCleanShutdown(t *testing.T) {
	script := []*fakeSupervisedClient{newFakeClient(nil, time.Time{})}
	h, done := newHarness(t, testPolicy(), script)

	res := h.sup.Run(done)

	if res.Reason != StopShutdown {
		t.Fatalf("expected StopShutdown, got %v", res.Reason)
	}
	if res.Err != nil {
		t.Errorf("expected no error, got %v", res.Err)
	}
	if len(h.clients) != 1 {
		t.Errorf("clean return must not reconnect, got %d clients", len(h.clients))
	}
	if len(h.waits) != 0 {
		t.Errorf("clean return must not sleep, got %v", h.waits)
	}
}

func TestSupervisorStopsClientWhenShutdownSignalledWhileRunning(t *testing.T) {
	blocking := newFakeClient(nil, time.Time{})
	blocking.block = true

	done := make(chan struct{})
	sup := &Supervisor{
		Name:      "test helper",
		Policy:    testPolicy(),
		NewClient: func() SupervisedClient { return blocking },
	}

	resCh := make(chan SupervisorResult, 1)
	go func() { resCh <- sup.Run(done) }()

	// Give Run() a moment to park inside the fake client, then signal shutdown.
	time.Sleep(20 * time.Millisecond)
	close(done)

	select {
	case res := <-resCh:
		if res.Reason != StopShutdown {
			t.Fatalf("expected StopShutdown, got %v (err=%v)", res.Reason, res.Err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("supervisor did not return after shutdown was signalled")
	}
	if !blocking.wasStopped() {
		t.Error("supervisor must call Stop() on the running client when shutdown is signalled")
	}
}

func TestSupervisorDoesNotRetryAfterShutdownDuringBackoff(t *testing.T) {
	transient := errors.New("recv: EOF")
	done := make(chan struct{})
	var clients int
	var waits []time.Duration
	sup := &Supervisor{
		Name:   "test helper",
		Policy: testPolicy(),
		NewClient: func() SupervisedClient {
			clients++
			return newFakeClient(transient, time.Time{})
		},
		now:    time.Now,
		jitter: func(int64) int64 { return 0 },
		sleep: func(d time.Duration, _ <-chan struct{}) bool {
			waits = append(waits, d)
			close(done)
			return false // shutdown observed during the backoff wait
		},
	}

	res := sup.Run(done)

	if res.Reason != StopShutdown {
		t.Fatalf("expected StopShutdown, got %v", res.Reason)
	}
	if clients != 1 {
		t.Errorf("expected exactly 1 attempt before shutdown, got %d", clients)
	}
	if len(waits) != 1 {
		t.Errorf("expected exactly 1 backoff wait, got %v", waits)
	}
}

func TestSupervisorReturnsShutdownWhenDoneAlreadyClosed(t *testing.T) {
	done := make(chan struct{})
	close(done)
	var clients int
	sup := &Supervisor{
		Name:   "test helper",
		Policy: testPolicy(),
		NewClient: func() SupervisedClient {
			clients++
			return newFakeClient(errors.New("boom"), time.Time{})
		},
	}

	res := sup.Run(done)

	if res.Reason != StopShutdown {
		t.Fatalf("expected StopShutdown, got %v", res.Reason)
	}
	if clients != 0 {
		t.Errorf("must not construct a client after shutdown, got %d", clients)
	}
}

func TestNextBackoffDoublesAndCaps(t *testing.T) {
	tests := []struct {
		name     string
		cur, max time.Duration
		want     time.Duration
	}{
		{"doubles below cap", 1 * time.Second, 8 * time.Second, 2 * time.Second},
		{"doubles to exactly cap", 4 * time.Second, 8 * time.Second, 8 * time.Second},
		{"clamps at cap", 8 * time.Second, 8 * time.Second, 8 * time.Second},
		{"clamps when already above cap", 30 * time.Second, 8 * time.Second, 8 * time.Second},
		{"windows tuning 30s to 1m", 30 * time.Second, 5 * time.Minute, 1 * time.Minute},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := nextBackoff(tc.cur, tc.max); got != tc.want {
				t.Errorf("nextBackoff(%v, %v) = %v, want %v", tc.cur, tc.max, got, tc.want)
			}
		})
	}
}

func TestBackoffWithJitterStaysInRange(t *testing.T) {
	tests := []struct {
		name    string
		backoff time.Duration
		jitter  int64 // value the injected source returns
		want    time.Duration
	}{
		{"no jitter", 4 * time.Second, 0, 4 * time.Second},
		{"max jitter is half the backoff", 4 * time.Second, int64(2 * time.Second), 6 * time.Second},
		{"mid jitter", 4 * time.Second, int64(time.Second), 5 * time.Second},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var askedFor int64
			got := backoffWithJitter(tc.backoff, func(n int64) int64 {
				askedFor = n
				return tc.jitter
			})
			if got != tc.want {
				t.Errorf("backoffWithJitter(%v) = %v, want %v", tc.backoff, got, tc.want)
			}
			// The jitter window must be [0, backoff/2] inclusive, matching the
			// agent's WS reconnect jitter so concurrent helpers desynchronise.
			if wantN := int64(tc.backoff/2) + 1; askedFor != wantN {
				t.Errorf("jitter source asked for n=%d, want %d", askedFor, wantN)
			}
		})
	}
}

func TestIsFatalHelperError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"plain transient", errors.New("recv: EOF"), false},
		{"connect refused", fmt.Errorf("connect: %w", errors.New("no such file or directory")), false},
		{"permanent reject", &PermanentRejectError{Code: "sid_mismatch"}, true},
		{"permanent reject wrapped", fmt.Errorf("authenticate: %w", &PermanentRejectError{Code: "x"}), true},
		{"not_desired is fatal", &PermanentRejectError{Code: "not_desired"}, true},
		{"sid lookup failed", fmt.Errorf("x: %w", ErrSIDLookupFailed), true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsFatalHelperError(tc.err); got != tc.want {
				t.Errorf("IsFatalHelperError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestReconnectPolicyNormalizeFillsSaneDefaults(t *testing.T) {
	got := ReconnectPolicy{}.normalize()
	if got.MinBackoff <= 0 || got.MaxBackoff < got.MinBackoff {
		t.Fatalf("normalize produced unusable backoff bounds: %+v", got)
	}
	if got.StableThreshold <= 0 {
		t.Errorf("normalize left StableThreshold unusable: %v", got.StableThreshold)
	}
	if got.WarnLimit <= 0 || got.WarnWindow <= 0 {
		t.Errorf("normalize left warn limiter unusable: limit=%d window=%v", got.WarnLimit, got.WarnWindow)
	}
	if got.StuckThreshold <= 0 {
		t.Error("normalize left StuckThreshold unusable; a zero threshold would escalate to ERROR on the first failed attempt")
	}

	// An explicit policy must be preserved untouched.
	explicit := ReconnectPolicy{
		MinBackoff:      2 * time.Second,
		MaxBackoff:      9 * time.Second,
		StableThreshold: 11 * time.Second,
		WarnLimit:       7,
		WarnWindow:      time.Minute,
		StuckThreshold:  3 * time.Minute,
	}
	if explicit.normalize() != explicit {
		t.Errorf("normalize mutated an explicit policy: %+v -> %+v", explicit, explicit.normalize())
	}

	// A max below min must be raised to min rather than producing a
	// backoff that shrinks on every attempt.
	inverted := ReconnectPolicy{MinBackoff: 10 * time.Second, MaxBackoff: time.Second}.normalize()
	if inverted.MaxBackoff < inverted.MinBackoff {
		t.Errorf("normalize left MaxBackoff (%v) below MinBackoff (%v)", inverted.MaxBackoff, inverted.MinBackoff)
	}
}

// capturingHandler records the levels and messages the supervisor logs.
type capturingHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

func (h *capturingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *capturingHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, r.Clone())
	return nil
}
func (h *capturingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *capturingHandler) WithGroup(string) slog.Handler      { return h }

func (h *capturingHandler) countAtLevel(level slog.Level, substr string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, r := range h.records {
		if r.Level == level && strings.Contains(r.Message, substr) {
			n++
		}
	}
	return n
}

// newStuckHarness builds a supervisor whose clock advances by exactly the
// backoff it was asked to sleep, so elapsed time is deterministic.
func newStuckHarness(policy ReconnectPolicy, runErr error, maxAttempts int, authAt func(attempt int) time.Time) (*Supervisor, *capturingHandler, chan struct{}) {
	done := make(chan struct{})
	handler := &capturingHandler{}
	now := time.Unix(1_700_000_000, 0).UTC()
	attempt := 0

	sup := &Supervisor{
		Name:   "desktop helper",
		Policy: policy,
		Log:    slog.New(handler),
		NewClient: func() SupervisedClient {
			attempt++
			if attempt > maxAttempts {
				select {
				case <-done:
				default:
					close(done)
				}
				return newFakeClient(nil, time.Time{})
			}
			var at time.Time
			if authAt != nil {
				at = authAt(attempt)
			}
			return newFakeClient(runErr, at)
		},
		now:    func() time.Time { return now },
		jitter: func(int64) int64 { return 0 },
	}
	sup.sleep = func(d time.Duration, _ <-chan struct{}) bool {
		now = now.Add(d)
		return true
	}
	return sup, handler, done
}

// A helper that never once connects used to die on every attempt, which made
// launchd/systemd report a crash-loop. Now that it stays resident, the ERROR
// line is the only thing that says "wedged" rather than "transiently
// reconnecting" — the warn limiter has demoted everything else to INFO by then.
func TestSupervisorEscalatesWhenItHasNeverConnected(t *testing.T) {
	policy := ReconnectPolicy{
		MinBackoff:      1 * time.Minute,
		MaxBackoff:      1 * time.Minute,
		StableThreshold: time.Minute,
		WarnLimit:       3,
		WarnWindow:      5 * time.Minute,
		StuckThreshold:  15 * time.Minute,
	}
	// 60 attempts x 1 minute of backoff = 60 simulated minutes.
	sup, handler, done := newStuckHarness(policy, errors.New("connect: no such file or directory"), 60, nil)

	if res := sup.Run(done); res.Reason != StopShutdown {
		t.Fatalf("expected StopShutdown, got %v", res.Reason)
	}

	got := handler.countAtLevel(slog.LevelError, "wedged")
	if got == 0 {
		t.Fatal("a helper that never connected must escalate to ERROR; nothing was logged at that level")
	}
	// Rate-limited to one per stuckLogInterval (30m): after crossing the 15m
	// threshold there are ~45 minutes left, so expect 2, never one-per-attempt.
	if got > 3 {
		t.Errorf("stuck ERROR logged %d times in 60 simulated minutes; it must be rate-limited, not per-attempt", got)
	}
}

// The escalation must stay quiet for a helper that is genuinely just
// reconnecting — otherwise it is noise and gets ignored.
func TestSupervisorDoesNotEscalateWhenItHasConnectedBefore(t *testing.T) {
	policy := ReconnectPolicy{
		MinBackoff:      1 * time.Minute,
		MaxBackoff:      1 * time.Minute,
		StableThreshold: time.Minute,
		WarnLimit:       3,
		WarnWindow:      5 * time.Minute,
		StuckThreshold:  15 * time.Minute,
	}
	base := time.Unix(1_700_000_000, 0).UTC()
	// Every attempt authenticated successfully before dropping.
	sup, handler, done := newStuckHarness(policy, errors.New("recv: EOF"), 60, func(int) time.Time {
		return base
	})

	if res := sup.Run(done); res.Reason != StopShutdown {
		t.Fatalf("expected StopShutdown, got %v", res.Reason)
	}

	if got := handler.countAtLevel(slog.LevelError, "wedged"); got != 0 {
		t.Errorf("a helper that has connected before must not be reported as wedged; got %d ERROR lines", got)
	}
}

// Below the threshold the helper is still plausibly waiting for the agent to
// come up (boot, upgrade) — crying wolf there trains people to ignore it.
func TestSupervisorDoesNotEscalateBeforeTheStuckThreshold(t *testing.T) {
	policy := ReconnectPolicy{
		MinBackoff:      1 * time.Minute,
		MaxBackoff:      1 * time.Minute,
		StableThreshold: time.Minute,
		WarnLimit:       3,
		WarnWindow:      5 * time.Minute,
		StuckThreshold:  15 * time.Minute,
	}
	// 5 attempts x 1 minute = 5 simulated minutes, well under the threshold.
	sup, handler, done := newStuckHarness(policy, errors.New("connect: no such file or directory"), 5, nil)

	if res := sup.Run(done); res.Reason != StopShutdown {
		t.Fatalf("expected StopShutdown, got %v", res.Reason)
	}

	if got := handler.countAtLevel(slog.LevelError, "wedged"); got != 0 {
		t.Errorf("escalated after only 5 simulated minutes (threshold is 15); got %d ERROR lines", got)
	}
}
