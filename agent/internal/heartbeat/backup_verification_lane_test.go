package heartbeat

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/workerpool"
)

// Issue #6106: backup_verify and backup_test_restore wait up to two hours on
// the backup helper. On the shared command pool that wait held one of
// MaxConcurrentCommands slots, so a few verifies could starve unrelated
// scripts and monitors. They now run on their own lane.

var backupVerificationCommandTypes = []string{tools.CmdBackupVerify, tools.CmdBackupTestRestore}

const poolFullError = "command rejected, worker pool full"

// saturateOnePool fills every worker and queue slot of a workerpool.New(1, 1)
// pool and returns the func that releases it.
func saturateOnePool(t *testing.T, p *workerpool.Pool) func() {
	t.Helper()
	blocker := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(blocker) }) }
	t.Cleanup(release)

	started := make(chan struct{})
	if !p.Submit(func() { close(started); <-blocker }) {
		t.Fatal("saturate: first submission rejected")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("saturate: worker never picked up the blocking task")
	}
	if !p.Submit(func() { <-blocker }) {
		t.Fatal("saturate: queue-filling submission rejected")
	}
	if p.Submit(func() {}) {
		t.Fatal("saturate: pool still accepts work, the test would prove nothing")
	}
	return release
}

func shutdownPoolsOnCleanup(t *testing.T, pools ...*workerpool.Pool) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for _, p := range pools {
			p.Shutdown(ctx)
		}
	})
}

func newLaneTestHeartbeat(t *testing.T) *Heartbeat {
	t.Helper()
	h := &Heartbeat{
		stopChan:         make(chan struct{}),
		pool:             workerpool.New(1, 1),
		verificationPool: workerpool.New(1, 1),
		seenCommands:     make(map[string]time.Time),
	}
	h.accepting.Store(true)
	shutdownPoolsOnCleanup(t, h.pool, h.verificationPool)
	return h
}

func TestCommandPoolForRoutesOnlyVerificationToTheLane(t *testing.T) {
	h := newLaneTestHeartbeat(t)
	for _, cmdType := range backupVerificationCommandTypes {
		if got := h.commandPoolFor(cmdType); got != h.verificationPool {
			t.Errorf("%s dispatched on %p, want the verification lane %p", cmdType, got, h.verificationPool)
		}
	}
	// backup_stop must never queue behind the verification it cancels, and
	// the other backup commands keep their existing pool.
	for _, cmdType := range []string{
		tools.CmdBackupStop, tools.CmdBackupRun, tools.CmdBackupRestore, tools.CmdBackupCleanup,
		tools.CmdRunScript, "test_unknown_type",
	} {
		if got := h.commandPoolFor(cmdType); got != h.pool {
			t.Errorf("%s dispatched on %p, want the shared pool %p", cmdType, got, h.pool)
		}
	}

	// A Heartbeat built without a lane (older test fixtures) keeps the
	// shared pool for everything rather than dispatching on nil.
	bare := &Heartbeat{pool: h.pool}
	if got := bare.commandPoolFor(tools.CmdBackupVerify); got != h.pool {
		t.Errorf("without a lane, backup_verify dispatched on %p, want the shared pool", got)
	}
}

// WebSocket delivery: a verification must still be admitted while every
// shared slot is busy.
func TestVerificationRunsWhileSharedPoolIsSaturated_WS(t *testing.T) {
	for _, cmdType := range backupVerificationCommandTypes {
		t.Run(cmdType, func(t *testing.T) {
			h := newLaneTestHeartbeat(t)
			saturateOnePool(t, h.pool)

			result, executed := h.executeCommandViaPoolReportingDelivery(Command{ID: "ws-" + cmdType, Type: cmdType})
			if result.Error == poolFullError {
				t.Fatalf("%s rejected because the shared pool is full; it must run on its own lane", cmdType)
			}
			if !executed {
				t.Fatalf("%s was not executed: %+v", cmdType, result)
			}
			// No session broker in this harness, so the forwarder fails fast.
			// Seeing its error proves the verification handler itself ran.
			if !strings.Contains(result.Error, "session broker not available") {
				t.Fatalf("%s result = %+v, want the forwarder's session-broker error", cmdType, result)
			}
		})
	}
}

// The other direction: verifications filling their lane must not block
// ordinary commands, and the lane stays bounded.
func TestOrdinaryCommandsRunWhileVerificationLaneIsSaturated_WS(t *testing.T) {
	h := newLaneTestHeartbeat(t)
	saturateOnePool(t, h.verificationPool)

	result, executed := h.executeCommandViaPoolReportingDelivery(Command{ID: "ws-ordinary", Type: "test_unknown_type"})
	if result.Error == poolFullError || !executed {
		t.Fatalf("ordinary command blocked by a saturated verification lane: executed=%v result=%+v", executed, result)
	}

	overflow, executed := h.executeCommandViaPoolReportingDelivery(Command{ID: "ws-overflow-verify", Type: tools.CmdBackupVerify})
	if executed || overflow.Error != poolFullError {
		t.Fatalf("verification past the lane's capacity: executed=%v result=%+v, want rejected as pool full", executed, overflow)
	}
}

// Heartbeat-poll delivery takes a different dispatch site; it must route the
// same way.
func TestVerificationRunsWhileSharedPoolIsSaturated_Poll(t *testing.T) {
	for _, cmdType := range backupVerificationCommandTypes {
		t.Run(cmdType, func(t *testing.T) {
			cmdID := "poll-" + cmdType
			submitted := make(chan string, 4)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				submitted <- r.URL.Path + " " + string(body)
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"success":true}`))
			}))
			defer srv.Close()

			h := newResultSubmitHeartbeat(srv.URL)
			h.pool = workerpool.New(1, 1)
			h.verificationPool = workerpool.New(1, 1)
			h.seenCommands = make(map[string]time.Time)
			h.accepting.Store(true)
			shutdownPoolsOnCleanup(t, h.pool, h.verificationPool)
			saturateOnePool(t, h.pool)

			if !h.dispatchPolledCommand(Command{ID: cmdID, Type: cmdType}) {
				t.Fatalf("%s rejected at dispatch while the shared pool is full", cmdType)
			}
			select {
			case got := <-submitted:
				if !strings.Contains(got, "/commands/"+cmdID+"/result") || !strings.Contains(got, "session broker not available") {
					t.Fatalf("submitted %q, want the verification's own result for %s", got, cmdID)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("%s never ran: no result was submitted", cmdType)
			}
		})
	}
}

// The production poll loop, not just the helper it calls, must route
// verifications onto the lane.
func TestHeartbeatResponseDispatchesVerificationOnTheLane(t *testing.T) {
	cmdID := "poll-response-verify"
	submitted := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		submitted <- r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	h := newResultSubmitHeartbeat(srv.URL)
	h.pool = workerpool.New(1, 1)
	h.verificationPool = workerpool.New(1, 1)
	h.seenCommands = make(map[string]time.Time)
	h.accepting.Store(true)
	shutdownPoolsOnCleanup(t, h.pool, h.verificationPool)
	saturateOnePool(t, h.pool)

	h.processHeartbeatResponse(&HeartbeatResponse{Commands: []Command{{ID: cmdID, Type: tools.CmdBackupVerify}}})

	select {
	case got := <-submitted:
		if !strings.Contains(got, "/commands/"+cmdID+"/result") {
			t.Fatalf("submitted %q, want the result for %s", got, cmdID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("backup_verify from a heartbeat response never ran while the shared pool was full")
	}
}

// The WebSocket wait must watch the context of the pool the command was
// submitted to. Watching the shared pool's instead would leave a caller
// parked on a verification that the lane's shutdown has already given up on.
//
// MUST NOT call t.Parallel(): mutates handlerRegistry.
func TestWSWaitObservesVerificationLaneShutdown(t *testing.T) {
	orig, hadOrig := handlerRegistry[tools.CmdBackupVerify]
	running := make(chan struct{})
	unblock := make(chan struct{})
	var unblockOnce sync.Once
	release := func() { unblockOnce.Do(func() { close(unblock) }) }
	// Before the pools' cleanup Shutdown, which would otherwise wait out its
	// deadline on the still-blocked handler.
	defer release()
	handlerRegistry[tools.CmdBackupVerify] = func(*Heartbeat, Command) tools.CommandResult {
		close(running)
		<-unblock
		return tools.CommandResult{Status: "completed"}
	}
	t.Cleanup(func() {
		release()
		if hadOrig {
			handlerRegistry[tools.CmdBackupVerify] = orig
		} else {
			delete(handlerRegistry, tools.CmdBackupVerify)
		}
	})

	h := newLaneTestHeartbeat(t)
	type outcome struct {
		result   tools.CommandResult
		executed bool
	}
	done := make(chan outcome, 1)
	go func() {
		r, executed := h.executeCommandViaPoolReportingDelivery(Command{ID: "ws-lane-shutdown", Type: tools.CmdBackupVerify})
		done <- outcome{r, executed}
	}()
	select {
	case <-running:
	case <-time.After(5 * time.Second):
		t.Fatal("verification never started on the lane")
	}

	// Drain with an expired deadline: the lane gives up on its in-flight task
	// and cancels its context, exactly as a shutdown that ran out of time does.
	expired, cancel := context.WithCancel(context.Background())
	cancel()
	h.verificationPool.Drain(expired)

	select {
	case got := <-done:
		if got.executed || got.result.Error != "command execution interrupted during shutdown" {
			t.Fatalf("wait returned executed=%v result=%+v, want the shutdown interruption", got.executed, got.result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("WebSocket wait did not observe the verification lane's shutdown")
	}
}

func TestStopAcceptingCommandsClosesTheVerificationLane(t *testing.T) {
	h := newLaneTestHeartbeat(t)
	h.StopAcceptingCommands()
	if h.verificationPool.Submit(func() {}) {
		t.Fatal("verification lane still accepts work after StopAcceptingCommands")
	}
	if h.pool.Submit(func() {}) {
		t.Fatal("shared pool still accepts work after StopAcceptingCommands")
	}
}

func TestDrainAndWaitDrainsTheVerificationLane(t *testing.T) {
	h := newLaneTestHeartbeat(t)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseTask := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseTask)
	finished := make(chan struct{})
	started := make(chan struct{})
	if !h.verificationPool.Submit(func() {
		close(started)
		<-release
		close(finished)
	}) {
		t.Fatal("verification lane rejected the task")
	}
	<-started

	h.StopAcceptingCommands()
	drained := make(chan struct{})
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.DrainAndWait(ctx)
		close(drained)
	}()

	select {
	case <-drained:
		t.Fatal("DrainAndWait returned while a verification was still running")
	case <-time.After(100 * time.Millisecond):
	}
	releaseTask()
	select {
	case <-drained:
	case <-time.After(5 * time.Second):
		t.Fatal("DrainAndWait did not return after the verification finished")
	}
	select {
	case <-finished:
	default:
		t.Fatal("DrainAndWait returned before the verification task completed")
	}
}
