package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Regression coverage for issue #3107: start_desktop is exempt from command
// dedup (#434), so two invocations for one desktop session can be in flight at
// once. They used to share the IPC id "desk-<sessionID>", so the second was
// rejected with ErrDuplicateCommand, that rejection was reported as a helper
// crash, and both retry attempts burned in the same millisecond.

// shrinkDesktopStartRetryBackoff makes the inter-attempt backoff test-sized and
// restores it afterwards. These tests are not parallel, so the package-level
// var is safe to swap (same pattern as desktopLeaseRenewEvery).
func shrinkDesktopStartRetryBackoff(t *testing.T, d time.Duration) {
	t.Helper()
	prev := desktopStartRetryBackoff
	desktopStartRetryBackoff = d
	t.Cleanup(func() { desktopStartRetryBackoff = prev })
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

// A duplicate-id rejection must be surfaced verbatim, not retried and not
// reported as a crash — the helper is alive and a retry cannot help.
func TestStartDesktopViaHelperDoesNotRetryDuplicateCommand(t *testing.T) {
	shrinkDesktopStartRetryBackoff(t, time.Millisecond)

	serverConn, clientConn := createTestSocketPair(t)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", "helper-1", []string{"desktop"})
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	// The helper answers with the duplicate-id error the broker would raise if
	// a shared correlation id were ever reintroduced.
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(10 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			return
		}
		_ = clientIPC.Send(&ipc.Envelope{
			ID:    env.ID,
			Type:  ipc.TypeDesktopStart,
			Error: "boom",
		})
	}()

	// Direct classification check: the loop only retries on a lost helper.
	dupErr := fmt.Errorf("%w: %q (session %q)", sessionbroker.ErrDuplicateCommand, "desk-desktop-1", "helper-1")
	if desktopStartLostHelper(dupErr) {
		t.Fatal("duplicate-id rejection classified as a helper death")
	}

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

// Shutdown must not be held open by a pending desktop-start retry.
func TestStartDesktopViaHelperAbortsRetryOnShutdown(t *testing.T) {
	shrinkDesktopStartRetryBackoff(t, 10*time.Second)

	stop := make(chan struct{})
	close(stop)

	calls := 0
	h := &Heartbeat{
		stopChan: stop,
		helperFinder: func(string) *sessionbroker.Session {
			calls++
			return newClosedHelperSession(t, fmt.Sprintf("helper-%d", calls))
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
