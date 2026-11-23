package heartbeat

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/wire"
	"github.com/breeze-rmm/agent/internal/workerpool"
)

// #11813: a verification can wait on the verification lane (bounded, like
// the shared pool) before it reaches the helper. The server's clock for the
// command (session deadline, stale-command reaper, verification timeout) runs
// from delivery, so the wait is spent out of the command's budget. The
// helper is told only what is left, and a verification left with less than a
// useful run is failed without being started.

// queueWaitClock is a settable clock that reports each read.
type queueWaitClock struct {
	mu    sync.Mutex
	now   time.Time
	reads chan struct{}
}

func newQueueWaitClock() *queueWaitClock {
	return &queueWaitClock{now: time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC), reads: make(chan struct{}, 64)}
}

func (c *queueWaitClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case c.reads <- struct{}{}:
	default:
	}
	return c.now
}

func (c *queueWaitClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// fakeBackupForwarder stands in for the session broker.
type fakeBackupForwarder struct {
	mu        sync.Mutex
	spawns    int
	forwarded []time.Duration
	sent      chan time.Duration
}

func newFakeBackupForwarder() *fakeBackupForwarder {
	return &fakeBackupForwarder{sent: make(chan time.Duration, 8)}
}

func (f *fakeBackupForwarder) GetOrSpawnBackupHelper(string) (*sessionbroker.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.spawns++
	return nil, nil
}

func (f *fakeBackupForwarder) ForwardBackupCommand(commandID, _ string, _ []byte, timeout time.Duration, _ bool, _ ...bool) (*ipc.Envelope, error) {
	f.mu.Lock()
	f.forwarded = append(f.forwarded, timeout)
	f.mu.Unlock()
	f.sent <- timeout
	payload, _ := json.Marshal(backupipc.BackupCommandResult{CommandID: commandID, Success: true, Stdout: `{"status":"passed"}`})
	return &ipc.Envelope{Payload: payload}, nil
}

func (f *fakeBackupForwarder) forwardCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.forwarded)
}

func verifyWithBudget(id, cmdType string, budget time.Duration) Command {
	return Command{ID: id, Type: cmdType, Payload: map[string]any{"snapshotId": "snap-1", "timeBudgetSeconds": budget.Seconds()}}
}

// occupyLane runs one blocking task on a workerpool.New(1, 1) lane so the
// next submission waits in its queue; it returns the release.
func occupyLane(t *testing.T, p *workerpool.Pool) func() {
	t.Helper()
	blocker := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(blocker) }) }
	t.Cleanup(release)
	started := make(chan struct{})
	if !p.Submit(func() { close(started); <-blocker }) {
		t.Fatal("occupy: submission rejected")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("occupy: worker never picked up the blocking task")
	}
	return release
}

func waitForClockRead(t *testing.T, clk *queueWaitClock) {
	t.Helper()
	select {
	case <-clk.reads:
	case <-time.After(5 * time.Second):
		t.Fatal("the verification was never stamped on receipt")
	}
}

func TestVerificationForwardTimeoutAfterWait(t *testing.T) {
	received := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	floor := backupipc.VerifyRunMargin + verificationMinUsefulRun
	cases := []struct {
		name       string
		budget     time.Duration
		receivedAt time.Time
		waited     time.Duration
		want       time.Duration
		wantOK     bool
	}{
		{"never stamped: the whole budget", 2 * time.Hour, time.Time{}, 0, 2 * time.Hour, true},
		{"no wait", 2 * time.Hour, received, 0, 2 * time.Hour, true},
		{"waited 30m of 2h", 2 * time.Hour, received, 30 * time.Minute, 90 * time.Minute, true},
		{"waited 37m of a scaled 6h35m", 395 * time.Minute, received, 37 * time.Minute, 358 * time.Minute, true},
		{"exactly a useful run left", 2 * time.Hour, received, 2*time.Hour - floor, floor, true},
		{"just under a useful run left", 2 * time.Hour, received, 2*time.Hour - floor + time.Millisecond, floor - time.Millisecond, false},
		{"waited past the whole budget", 2 * time.Hour, received, 3 * time.Hour, -time.Hour, false},
		{"clock stepped back: no deduction", 2 * time.Hour, received, -10 * time.Minute, 2 * time.Hour, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := verificationForwardTimeoutAfterWait(tc.budget, tc.receivedAt, received.Add(tc.waited))
			if got != tc.want || ok != tc.wantOK {
				t.Fatalf("verificationForwardTimeoutAfterWait = (%v, %v), want (%v, %v)", got, ok, tc.want, tc.wantOK)
			}
			if ok && got <= backupipc.VerifyRunMargin {
				// The helper treats a TimeoutMs no longer than its margin as
				// "no timeout" and runs its 1h50m default instead.
				t.Fatalf("forwarded %v, which is not longer than the helper's margin %v", got, backupipc.VerifyRunMargin)
			}
		})
	}
}

func newQueueWaitHeartbeat(t *testing.T, serverURL string) (*Heartbeat, *queueWaitClock, *fakeBackupForwarder) {
	t.Helper()
	var h *Heartbeat
	if serverURL != "" {
		h = newResultSubmitHeartbeat(serverURL)
	} else {
		h = &Heartbeat{stopChan: make(chan struct{})}
	}
	h.pool = workerpool.New(1, 1)
	h.verificationPool = workerpool.New(1, 1)
	h.seenCommands = make(map[string]time.Time)
	h.accepting.Store(true)
	shutdownPoolsOnCleanup(t, h.pool, h.verificationPool)
	clk := newQueueWaitClock()
	fwd := newFakeBackupForwarder()
	h.verificationClock = clk.Now
	h.backupForwarderOverride = fwd
	return h, clk, fwd
}

// WebSocket delivery: the wait in the lane comes off the helper's TimeoutMs.
func TestVerificationQueuedOnTheLaneForwardsTheRemainingBudget_WS(t *testing.T) {
	for _, cmdType := range backupVerificationCommandTypes {
		t.Run(cmdType, func(t *testing.T) {
			h, clk, fwd := newQueueWaitHeartbeat(t, "")
			release := occupyLane(t, h.verificationPool)

			done := make(chan tools.CommandResult, 1)
			go func() {
				result, _ := h.executeCommandViaPoolReportingDelivery(verifyWithBudget("ws-wait-"+cmdType, cmdType, 395*time.Minute))
				done <- result
			}()
			waitForClockRead(t, clk)
			clk.Advance(37 * time.Minute)
			release()

			select {
			case got := <-fwd.sent:
				if want := 395*time.Minute - 37*time.Minute; got != want {
					t.Fatalf("forwarded TimeoutMs %v, want the budget less the lane wait %v", got, want)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the verification never reached the helper")
			}
			if result := <-done; result.Status != "completed" {
				t.Fatalf("result = %+v, want the helper's completed result", result)
			}
		})
	}
}

// Heartbeat-poll delivery takes the other dispatch site; same accounting.
func TestVerificationQueuedOnTheLaneForwardsTheRemainingBudget_Poll(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	h, clk, fwd := newQueueWaitHeartbeat(t, srv.URL)
	release := occupyLane(t, h.verificationPool)
	if !h.dispatchPolledCommand(verifyWithBudget("poll-wait", tools.CmdBackupVerify, 2*time.Hour)) {
		t.Fatal("verification rejected at dispatch")
	}
	clk.Advance(50 * time.Minute)
	release()

	select {
	case got := <-fwd.sent:
		if want := 70 * time.Minute; got != want {
			t.Fatalf("forwarded TimeoutMs %v, want the budget less the lane wait %v", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the verification never reached the helper")
	}
}

// A verification left with less than a useful run fails fast with a typed
// code and never reaches the helper.
func TestVerificationQueuedPastAUsefulRunFailsWithoutReachingTheHelper(t *testing.T) {
	for _, cmdType := range backupVerificationCommandTypes {
		t.Run(cmdType, func(t *testing.T) {
			h, clk, fwd := newQueueWaitHeartbeat(t, "")
			release := occupyLane(t, h.verificationPool)

			done := make(chan tools.CommandResult, 1)
			go func() {
				result, _ := h.executeCommandViaPoolReportingDelivery(verifyWithBudget("ws-expired-"+cmdType, cmdType, 2*time.Hour))
				done <- result
			}()
			waitForClockRead(t, clk)
			// 14 minutes left: under the helper's 10m margin + a 5m run.
			clk.Advance(2*time.Hour - 14*time.Minute)
			release()

			var result tools.CommandResult
			select {
			case result = <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("no result")
			}
			if result.Status != "failed" || result.ErrorCode != wire.ErrCodeVerificationQueueExpired {
				t.Fatalf("result = %+v, want failed with %q", result, wire.ErrCodeVerificationQueueExpired)
			}
			if !strings.Contains(result.Error, "not started") {
				t.Fatalf("error = %q, want it to say the verification was not started", result.Error)
			}
			if n := fwd.forwardCount(); n != 0 {
				t.Fatalf("forwarded %d command(s) to the helper, want none", n)
			}
		})
	}
}

// Unchanged when nothing waited: the forward wait is the whole budget.
func TestVerificationWithoutAWaitForwardsTheWholeBudget(t *testing.T) {
	h, _, fwd := newQueueWaitHeartbeat(t, "")
	result, executed := h.executeCommandViaPoolReportingDelivery(verifyWithBudget("ws-nowait", tools.CmdBackupVerify, 395*time.Minute))
	if !executed || result.Status != "completed" {
		t.Fatalf("executed=%v result=%+v", executed, result)
	}
	if got := <-fwd.sent; got != 395*time.Minute {
		t.Fatalf("forwarded TimeoutMs %v, want the whole budget", got)
	}

	// A handler reached without a receipt stamp (no dispatch site) deducts nothing.
	direct := handleBackupTestRestore(h, Command{ID: "direct", Type: tools.CmdBackupTestRestore, Payload: map[string]any{}})
	if direct.Status != "completed" {
		t.Fatalf("direct result = %+v", direct)
	}
	if got := <-fwd.sent; got != backupipc.VerifyCommandTimeout {
		t.Fatalf("forwarded TimeoutMs %v, want the 2h base", got)
	}

	// Other backup commands keep their fixed wait.
	if cleanup := handleBackupCleanup(h, Command{ID: "cleanup", Type: tools.CmdBackupCleanup, Payload: map[string]any{}}); cleanup.Status != "completed" {
		t.Fatalf("cleanup result = %+v", cleanup)
	}
	if got := <-fwd.sent; got != time.Minute {
		t.Fatalf("cleanup forwarded %v, want 1m", got)
	}
}
