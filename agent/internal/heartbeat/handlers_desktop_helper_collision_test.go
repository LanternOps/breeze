package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Regression coverage for issue #3107: start_desktop is exempt from command
// dedup (#434), so two invocations for one desktop session can be in flight at
// once. They used to share the IPC id "desk-<sessionID>", so the second was
// rejected with ErrDuplicateCommand, that rejection was reported as a helper
// crash, and both retry attempts burned in the same millisecond.

// shrinkDesktopStartRetryBackoff makes the inter-attempt backoff test-sized and
// restores it afterwards (same pattern as desktopLeaseRenewEvery).
//
// RULE: these swap package-level vars, so any test that exercises
// startDesktopViaHelper must NOT call t.Parallel().
func shrinkDesktopStartRetryBackoff(t *testing.T, d time.Duration) {
	t.Helper()
	prev := desktopStartRetryBackoff
	desktopStartRetryBackoff = d
	t.Cleanup(func() { desktopStartRetryBackoff = prev })
}

// shrinkDesktopStartCommandTimeout bounds one IPC round-trip. Same
// no-t.Parallel rule as above.
func shrinkDesktopStartCommandTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	prev := desktopStartCommandTimeout
	desktopStartCommandTimeout = d
	t.Cleanup(func() { desktopStartCommandTimeout = prev })
}

// newClosedHelperSession returns a desktop-capable session that is already
// closed, so SendCommand fails the way a helper death does.
func newClosedHelperSession(t *testing.T, id string) *sessionbroker.Session {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", id, []string{"desktop"})
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientConn.Close()
	})
	_ = session.Close()
	return session
}

func TestNextDesktopStartCommandIDIsUniquePerInvocation(t *testing.T) {
	const goroutines = 8
	const perGoroutine = 32

	var mu sync.Mutex
	seen := make(map[string]bool, goroutines*perGoroutine)

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < perGoroutine; j++ {
				id := nextDesktopStartCommandID("desktop-1")
				mu.Lock()
				if seen[id] {
					t.Errorf("duplicate desktop start command id %q", id)
				}
				seen[id] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if len(seen) != goroutines*perGoroutine {
		t.Fatalf("got %d distinct ids, want %d", len(seen), goroutines*perGoroutine)
	}
	for id := range seen {
		if !strings.HasPrefix(id, "desk-desktop-1-") {
			t.Fatalf("id %q lost the desktop session id — helper logs must stay greppable", id)
		}
	}
}

func TestDesktopStartLostHelper(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "nil error is not a helper loss",
			err:  nil,
			want: false,
		},
		{
			name: "duplicate command id means a live helper already has a start in flight",
			err:  fmt.Errorf("%w: %q (session %q)", sessionbroker.ErrDuplicateCommand, "desk-x", "helper-1"),
			want: false,
		},
		{
			name: "bare duplicate command sentinel",
			err:  sessionbroker.ErrDuplicateCommand,
			want: false,
		},
		{
			name: "command timeout means a connected but wedged helper",
			err:  sessionbroker.ErrCommandTimeout,
			want: false,
		},
		{
			name: "wrapped command timeout",
			err:  fmt.Errorf("desktop start: %w", sessionbroker.ErrCommandTimeout),
			want: false,
		},
		{
			name: "session closed before the command was queued",
			err:  errors.New("session closed"),
			want: true,
		},
		{
			name: "session torn down while waiting for the response",
			err:  errors.New("session closed while waiting for response"),
			want: true,
		},
		{
			name: "socket write failure",
			err:  errors.New("ipc: write: broken pipe"),
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := desktopStartLostHelper(tt.err); got != tt.want {
				t.Fatalf("desktopStartLostHelper(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

// TestConcurrentStartDesktopOnSessionDoesNotSelfCollide is the #3107 regression
// test: two simultaneous starts for the SAME desktop session against the SAME
// healthy helper must both reach the helper with distinct correlation ids, and
// neither may be reported as a helper death.
func TestConcurrentStartDesktopOnSessionDoesNotSelfCollide(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", "helper-1", []string{"desktop"})
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	const starts = 2
	idsCh := make(chan string, starts)

	// Fake helper: read BOTH requests before answering either, which is what
	// forces the two starts to be genuinely in flight at the same time. Replies
	// are sent from this one goroutine, so the IPC write path is not exercised
	// concurrently from the helper side.
	go func() {
		envs := make([]*ipc.Envelope, 0, starts)
		for i := 0; i < starts; i++ {
			_ = clientIPC.SetReadDeadline(time.Now().Add(10 * time.Second))
			env, err := clientIPC.Recv()
			if err != nil {
				t.Errorf("helper recv %d: %v", i, err)
				close(idsCh)
				return
			}
			envs = append(envs, env)
			idsCh <- env.ID
		}
		for i, env := range envs {
			payload, _ := json.Marshal(ipc.DesktopStartResponse{
				SessionID: "desktop-1",
				Answer:    fmt.Sprintf("answer-%d", i),
			})
			if err := clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStart, Payload: payload}); err != nil {
				t.Errorf("helper send %d: %v", i, err)
			}
		}
		close(idsCh)
	}()

	h := &Heartbeat{}
	req := ipc.DesktopStartRequest{SessionID: "desktop-1", Offer: "offer"}

	type attempt struct {
		status     string
		errMessage string
		lostHelper bool
	}
	results := make([]attempt, starts)
	var wg sync.WaitGroup
	for i := 0; i < starts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			result, lost := h.startDesktopOnSession(session, "desktop-1", req)
			results[i] = attempt{status: result.Status, errMessage: result.Error, lostHelper: lost}
		}(i)
	}
	wg.Wait()

	for i, got := range results {
		if got.status != "completed" {
			t.Errorf("start %d: status = %q, error = %q; want completed", i, got.status, got.errMessage)
		}
		if got.lostHelper {
			t.Errorf("start %d: reported a helper death against a healthy helper (error %q)", i, got.errMessage)
		}
		if strings.Contains(got.errMessage, "duplicate in-flight command id") {
			t.Errorf("start %d: self-collided on the shared IPC id: %s", i, got.errMessage)
		}
	}

	seen := map[string]bool{}
	for id := range idsCh {
		if seen[id] {
			t.Fatalf("helper received the same command id twice: %q", id)
		}
		seen[id] = true
	}
	if len(seen) != starts {
		t.Fatalf("helper received %d distinct command ids, want %d", len(seen), starts)
	}
}

// TestStartDesktopViaHelperSpacesRetriesAndReportsRealError covers the two
// downstream halves of #3107: retries must not burn in the same millisecond,
// and the terminal message must carry the underlying error instead of an
// unconditional "helper keeps crashing".
func TestStartDesktopViaHelperSpacesRetriesAndReportsRealError(t *testing.T) {
	const backoff = 60 * time.Millisecond
	shrinkDesktopStartRetryBackoff(t, backoff)

	var mu sync.Mutex
	var attemptAt []time.Time
	h := &Heartbeat{
		helperFinder: func(string) *sessionbroker.Session {
			mu.Lock()
			attemptAt = append(attemptAt, time.Now())
			n := len(attemptAt)
			mu.Unlock()
			return newClosedHelperSession(t, fmt.Sprintf("helper-%d", n))
		},
	}

	result := h.startDesktopViaHelper("desktop-1", "offer", nil, 0, desktop.DefaultSessionPolicy(), map[string]any{})

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if strings.Contains(result.Error, "helper keeps crashing") {
		t.Errorf("terminal error still blames a crash unconditionally: %s", result.Error)
	}
	if !strings.Contains(result.Error, "session closed") {
		t.Errorf("terminal error dropped the underlying cause: %s", result.Error)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(attemptAt) != 2 {
		t.Fatalf("helperFinder called %d times, want 2", len(attemptAt))
	}
	if gap := attemptAt[1].Sub(attemptAt[0]); gap < backoff {
		t.Fatalf("retry burned %v after the first attempt, want at least %v", gap, backoff)
	}
}

// A helper-reported failure is terminal and surfaced verbatim.
func TestStartDesktopViaHelperSurfacesHelperReportedError(t *testing.T) {
	shrinkDesktopStartRetryBackoff(t, time.Millisecond)

	serverConn, clientConn := createTestSocketPair(t)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", "helper-1", []string{"desktop"})
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(10 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			return
		}
		_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStart, Error: "boom"})
	}()

	calls := 0
	h := &Heartbeat{
		helperFinder: func(string) *sessionbroker.Session {
			calls++
			return session
		},
	}
	result := h.startDesktopViaHelper("desktop-1", "offer", nil, 0, desktop.DefaultSessionPolicy(), map[string]any{})
	if result.Status != "failed" || result.Error != "boom" {
		t.Fatalf("helper-reported error not surfaced verbatim: status=%q error=%q", result.Status, result.Error)
	}
	if calls != 1 {
		t.Fatalf("helperFinder called %d times, want 1 (a helper-reported failure is terminal)", calls)
	}
}

// TestStartDesktopViaHelperDoesNotRetryWedgedHelper pins the classifier into
// the retry loop. A live helper that never answers must fail once, not twice:
// the session stayed up, so nothing crashed and helperSessionForTarget would
// only hand the retry back the very same wedged session.
//
// This is the test that fails if desktopStartLostHelper is ever bypassed and
// startDesktopOnSession goes back to reporting every error as a helper death.
func TestStartDesktopViaHelperDoesNotRetryWedgedHelper(t *testing.T) {
	shrinkDesktopStartRetryBackoff(t, time.Millisecond)
	shrinkDesktopStartCommandTimeout(t, 150*time.Millisecond)

	serverConn, clientConn := createTestSocketPair(t)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", "helper-1", []string{"desktop"})
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})
	// RecvLoop runs, so the session stays registered and connected — it just
	// never produces a response. That is a wedged helper, not a dead one.
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	calls := 0
	h := &Heartbeat{
		helperFinder: func(string) *sessionbroker.Session {
			calls++
			return session
		},
	}

	result := h.startDesktopViaHelper("desktop-1", "offer", nil, 0, desktop.DefaultSessionPolicy(), map[string]any{})

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if calls != 1 {
		t.Fatalf("helperFinder called %d times, want 1 — a timeout against a live session is not a helper death", calls)
	}
	if !strings.Contains(result.Error, "did not answer the start request") {
		t.Errorf("timeout not translated into an operator-facing message: %s", result.Error)
	}
	if strings.Contains(result.Error, "helper session dropped each time") {
		t.Errorf("timeout wrongly reported as a dropped helper session: %s", result.Error)
	}
}

// Shutdown must not be held open by a pending desktop-start retry.
func TestStartDesktopViaHelperAbortsRetryOnShutdown(t *testing.T) {
	shrinkDesktopStartRetryBackoff(t, 10*time.Second)

	stop := make(chan struct{})
	close(stop)

	// Built on the TEST goroutine: createTestSocketPair calls t.Fatalf, which
	// only Goexits the goroutine it runs on, so constructing it inside
	// helperFinder (which runs on the goroutine below) would turn a setup
	// failure into a misleading 5s timeout.
	dead := newClosedHelperSession(t, "helper-1")

	calls := 0
	h := &Heartbeat{
		stopChan: stop,
		helperFinder: func(string) *sessionbroker.Session {
			calls++
			return dead
		},
	}

	done := make(chan struct{})
	var result string
	go func() {
		result = h.startDesktopViaHelper("desktop-1", "offer", nil, 0, desktop.DefaultSessionPolicy(), map[string]any{}).Error
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("startDesktopViaHelper blocked on the retry backoff during shutdown")
	}

	if !strings.Contains(result, "shutdown") {
		t.Fatalf("error = %q, want a shutdown-aborted message", result)
	}
	if calls != 1 {
		t.Fatalf("helperFinder called %d times, want 1 (shutdown aborts before the retry)", calls)
	}
}

// TestJoinOrRunDesktopStartJoinsSameOffer proves the collapse semantics with no
// timing dependency: a leader is already registered and finished, so a start
// carrying the SAME offer must take the leader's result and never run its own.
//
// This is what keeps a second concurrent start off the helper. Two starts
// reaching SessionManager.StartSession would have the second tear down the
// first, which the unique-id change alone would have made reachable.
func TestJoinOrRunDesktopStartJoinsSameOffer(t *testing.T) {
	const sessionID = "desktop-join"
	leader := &desktopStartCall{offer: "offer-A", done: make(chan struct{})}
	leader.result = tools.NewSuccessResult(map[string]any{"answer": "leader-answer"}, 0)
	close(leader.done)
	desktopStartInflight.Store(sessionID, leader)
	t.Cleanup(func() { desktopStartInflight.Delete(sessionID) })

	h := &Heartbeat{}
	ran := false
	got := h.joinOrRunDesktopStart(sessionID, "offer-A", func() tools.CommandResult {
		ran = true
		return tools.NewErrorResult(errors.New("second start reached the helper"), 0)
	})

	if ran {
		t.Fatal("a concurrent start with the same offer ran its own helper round-trip instead of joining")
	}
	if got.Status != "completed" || got.Stdout != leader.result.Stdout {
		t.Fatalf("joiner did not receive the leader's result: %+v", got)
	}
}

// A different offer is a new negotiation and must NOT be answered with the
// leader's SDP — it waits its turn and runs its own start.
func TestJoinOrRunDesktopStartDefersDifferentOffer(t *testing.T) {
	const sessionID = "desktop-defer"
	leader := &desktopStartCall{offer: "offer-A", done: make(chan struct{})}
	leader.result = tools.NewSuccessResult(map[string]any{"answer": "leader-answer"}, 0)
	desktopStartInflight.Store(sessionID, leader)

	// The leader finishes the way a real one does: delete, then close.
	go func() {
		desktopStartInflight.Delete(sessionID)
		close(leader.done)
	}()

	h := &Heartbeat{}
	ran := false
	got := h.joinOrRunDesktopStart(sessionID, "offer-B", func() tools.CommandResult {
		ran = true
		return tools.NewSuccessResult(map[string]any{"answer": "own-answer"}, 0)
	})

	if !ran {
		t.Fatal("a different offer was answered with the leader's SDP instead of renegotiating")
	}
	if got.Status != "completed" || !strings.Contains(got.Stdout, "own-answer") {
		t.Fatalf("deferred start did not return its own result: %+v", got)
	}
	if _, still := desktopStartInflight.Load(sessionID); still {
		t.Error("in-flight entry leaked after the deferred start completed")
	}
}

// Waiting on someone else's in-flight start must not hold shutdown open.
func TestJoinOrRunDesktopStartAbortsOnShutdown(t *testing.T) {
	const sessionID = "desktop-shutdown"
	leader := &desktopStartCall{offer: "offer-A", done: make(chan struct{})} // never closed
	desktopStartInflight.Store(sessionID, leader)
	t.Cleanup(func() { desktopStartInflight.Delete(sessionID) })

	stop := make(chan struct{})
	close(stop)
	h := &Heartbeat{stopChan: stop}

	done := make(chan tools.CommandResult, 1)
	go func() {
		done <- h.joinOrRunDesktopStart(sessionID, "offer-A", func() tools.CommandResult {
			return tools.NewSuccessResult(map[string]any{}, 0)
		})
	}()

	select {
	case got := <-done:
		if !strings.Contains(got.Error, "shutdown") {
			t.Fatalf("error = %q, want a shutdown-aborted message", got.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("joinOrRunDesktopStart blocked on an in-flight leader during shutdown")
	}
}

// TestJoinOrRunDesktopStartNeverRunsTwoAtOnce asserts the invariant that
// actually matters and that no scheduling order can break: however the
// goroutines interleave, at most one start for a given desktop session is ever
// executing. A late arrival running sequentially is correct; two overlapping is
// the bug.
func TestJoinOrRunDesktopStartNeverRunsTwoAtOnce(t *testing.T) {
	const sessionID = "desktop-invariant"
	const callers = 6
	t.Cleanup(func() { desktopStartInflight.Delete(sessionID) })

	var live, maxLive int32
	h := &Heartbeat{}

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.joinOrRunDesktopStart(sessionID, "offer-A", func() tools.CommandResult {
				n := atomic.AddInt32(&live, 1)
				for {
					prev := atomic.LoadInt32(&maxLive)
					if n <= prev || atomic.CompareAndSwapInt32(&maxLive, prev, n) {
						break
					}
				}
				time.Sleep(2 * time.Millisecond)
				atomic.AddInt32(&live, -1)
				return tools.NewSuccessResult(map[string]any{"answer": "a"}, 0)
			})
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&maxLive); got != 1 {
		t.Fatalf("%d desktop starts ran concurrently for one session, want at most 1", got)
	}
	if _, still := desktopStartInflight.Load(sessionID); still {
		t.Error("in-flight entry leaked")
	}
}
