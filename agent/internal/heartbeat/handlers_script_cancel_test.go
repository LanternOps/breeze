package heartbeat

import (
	"encoding/json"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/workerpool"
)

// #3525 script_cancel: bypass lane, structured outcome, helper fan-out.

// newTestHeartbeatWithPool builds a Heartbeat whose worker pool is as small as
// production can legitimately get: MaxConcurrentCommands clamps to a floor of 1
// (config/validate.go).
func newTestHeartbeatWithPool(workers, queue int) *Heartbeat {
	h := &Heartbeat{
		executor: executor.New(nil),
		pool:     workerpool.New(workers, queue),
	}
	h.accepting.Store(true)
	return h
}

func cancelCommand(id, executionID string, graceSeconds int) Command {
	return Command{
		ID:   id,
		Type: tools.CmdScriptCancel,
		Payload: map[string]any{
			"executionId":  executionID,
			"graceSeconds": float64(graceSeconds),
		},
	}
}

// cancelPayload decodes the structured body tools.NewSuccessResult marshals
// into Stdout. That is the wire the server reads it off.
func cancelPayload(t *testing.T, result tools.CommandResult) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("result carried no structured payload (%v): %+v", err, result)
	}
	return payload
}

func outcomeOf(t *testing.T, result tools.CommandResult) string {
	t.Helper()
	outcome, _ := cancelPayload(t, result)["outcome"].(string)
	return outcome
}

// saturatePool blocks every worker AND fills the queue, so any further Submit
// is rejected outright ("command rejected, worker pool full").
func saturatePool(t *testing.T, h *Heartbeat, slots int) {
	t.Helper()
	blocker := make(chan struct{})
	t.Cleanup(func() { close(blocker) })
	for i := 0; i < slots; i++ {
		if !h.pool.Submit(func() { <-blocker }) {
			t.Fatalf("could not saturate the pool at slot %d", i)
		}
		time.Sleep(20 * time.Millisecond) // let a worker pick the blocker up
	}
}

func TestScriptCancelBypassesTheWorkerPool(t *testing.T) {
	// A cancel that goes through the pool queues behind the very script it must
	// stop — or is rejected outright once the queue is full.
	h := newTestHeartbeatWithPool(1, 1)
	saturatePool(t, h, 2)

	done := make(chan tools.CommandResult, 1)
	go func() { done <- h.executeCommandViaPool(cancelCommand("cmd-bypass", "no-such-exec", 0)) }()

	select {
	case result := <-done:
		if result.Status != "completed" {
			t.Fatalf("cancel starved behind the pool: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel never completed while the worker pool was saturated")
	}
}

func TestScriptListRunningBypassesTheWorkerPool(t *testing.T) {
	h := newTestHeartbeatWithPool(1, 1)
	saturatePool(t, h, 2)

	done := make(chan tools.CommandResult, 1)
	go func() {
		done <- h.executeCommandViaPool(Command{ID: "cmd-list", Type: tools.CmdScriptListRunning})
	}()
	select {
	case result := <-done:
		if result.Status != "completed" {
			t.Fatalf("script_list_running starved behind the pool: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("script_list_running never completed while the worker pool was saturated")
	}
}

func TestOrdinaryCommandsStillGoThroughTheWorkerPool(t *testing.T) {
	// The bypass must stay narrow: a saturated pool still rejects a script, or
	// the pool stops bounding concurrency at all.
	h := newTestHeartbeatWithPool(1, 1)
	saturatePool(t, h, 2)

	result := h.executeCommandViaPool(Command{ID: "cmd-script", Type: tools.CmdScript, Payload: map[string]any{"content": "echo hi"}})
	if result.Status != "failed" || result.Error != "command rejected, worker pool full" {
		t.Fatalf("a script slipped past the saturated pool: %+v", result)
	}
}

func TestScriptCancelReportsNotFoundAsASuccessResult(t *testing.T) {
	// An unknown id used to return tools.NewErrorResult, which the server cannot
	// distinguish from a failed kill — and the two close the execution's
	// cancel_state differently (unconfirmed vs failed).
	h := newTestHeartbeat(nil)
	result := handleScriptCancel(h, cancelCommand("cmd-nf", "nonexistent", 5))
	if result.Status != "completed" {
		t.Fatalf("want a success result carrying the outcome, got %+v", result)
	}
	if got := outcomeOf(t, result); got != "not_found" {
		t.Fatalf("outcome = %q, want not_found", got)
	}
	if payload := cancelPayload(t, result); payload["cancelled"] != false {
		t.Fatalf("cancelled = %v for not_found; only a proven stop may claim true", payload["cancelled"])
	}
}

func TestScriptCancelReportsTerminatedForARunningScript(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	h := newTestHeartbeat(nil)
	scriptDone := make(chan tools.CommandResult, 1)
	go func() {
		scriptDone <- handleScript(h, Command{
			ID:   "cmd-run-1",
			Type: tools.CmdScript,
			Payload: map[string]any{
				"content":        "for _ in $(seq 1 600); do sleep 0.1; done",
				"language":       "bash",
				"timeoutSeconds": 120,
			},
		})
	}()

	deadline := time.Now().Add(10 * time.Second)
	for len(h.executor.ListRunning()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("script never registered as running")
		}
		time.Sleep(10 * time.Millisecond)
	}

	result := handleScriptCancel(h, cancelCommand("cmd-cancel-1", "cmd-run-1", 0))
	if result.Status != "completed" {
		t.Fatalf("cancel failed: %+v", result)
	}
	if got := outcomeOf(t, result); got != "terminated" {
		t.Fatalf("outcome = %q, want terminated", got)
	}
	if cancelPayload(t, result)["cancelled"] != true {
		t.Fatal("cancelled = false after a proven termination")
	}

	select {
	case <-scriptDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the script kept running after a terminated cancel")
	}
}

func TestScriptCancelMalformedPayloadStaysAnError(t *testing.T) {
	h := newTestHeartbeat(nil)
	result := handleScriptCancel(h, Command{ID: "cmd-bad", Type: tools.CmdScriptCancel, Payload: map[string]any{}})
	if result.Status != "failed" {
		t.Fatalf("a malformed payload must still fail the command, got %+v", result)
	}
}

// respondToHelperCancel plays a user helper answering one script_cancel with
// the given structured outcome.
func respondToHelperCancel(clientIPC *ipc.Conn, executionID, outcome string, cancelled bool) {
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			return
		}
		resultPayload, _ := json.Marshal(map[string]any{
			"executionId": executionID,
			"outcome":     outcome,
			"cancelled":   cancelled,
		})
		payload, _ := json.Marshal(ipc.IPCCommandResult{CommandID: env.ID, Status: "completed", Result: resultPayload})
		_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeCommandResult, Payload: payload})
	}()
}

func TestNotFoundMeansNoHelperAndNoLocalExecutorHasIt(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "helper-owns", []string{"run_as_user"})

	respondToHelperCancel(clientIPC, "cmd-9", "terminated", true)
	go session.RecvLoop(func(s *sessionbroker.Session, env *ipc.Envelope) {})

	h := newTestHeartbeat(newTestBrokerWithSessions(t, session))
	result := handleScriptCancel(h, cancelCommand("cmd-9", "cmd-9", 0))

	_ = session.Close()
	_ = clientIPC.Close()

	got := outcomeOf(t, result)
	if got == "not_found" {
		t.Fatal("reported not_found while a helper still owned the process")
	}
	if got != "terminated" {
		t.Fatalf("outcome = %q, want the helper's terminated", got)
	}
}

func TestHelperNotFoundOnlyWinsWhenEveryHelperAgrees(t *testing.T) {
	// One helper answers not_found, the other cannot be reached at all. The
	// unreachable helper may still own the process, so the combined answer must
	// not be not_found — that would let the server revert the execution as if
	// nothing had ever been running.
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	answering := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-a", []string{"run_as_user"})

	respondToHelperCancel(clientIPC, "cmd-x", "not_found", false)
	go answering.RecvLoop(func(s *sessionbroker.Session, env *ipc.Envelope) {})

	deadServer, deadClient := createTestSocketPair(t)
	deadSession := sessionbroker.NewSession(ipc.NewConn(deadServer), 1001, "1001", "bob", "quartz", "helper-dead", []string{"run_as_user"})
	_ = deadServer.Close()
	_ = deadClient.Close()

	h := newTestHeartbeat(newTestBrokerWithSessions(t, answering, deadSession))
	result := handleScriptCancel(h, cancelCommand("cmd-x", "cmd-x", 0))

	_ = answering.Close()
	_ = clientIPC.Close()

	if got := outcomeOf(t, result); got == "not_found" {
		t.Fatalf("outcome = not_found although one helper could not be reached: %+v", result)
	}
}

func TestEveryHelperSayingNotFoundIsNotFound(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-only", []string{"run_as_user"})

	respondToHelperCancel(clientIPC, "cmd-y", "not_found", false)
	go session.RecvLoop(func(s *sessionbroker.Session, env *ipc.Envelope) {})

	h := newTestHeartbeat(newTestBrokerWithSessions(t, session))
	result := handleScriptCancel(h, cancelCommand("cmd-y", "cmd-y", 0))

	_ = session.Close()
	_ = clientIPC.Close()

	if got := outcomeOf(t, result); got != "not_found" {
		t.Fatalf("outcome = %q, want not_found when the only helper also has no such execution", got)
	}
}

func TestHelperIsNotConsultedWhenTheLocalExecutorHandledTheCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-idle", []string{"run_as_user"})
	consulted := make(chan struct{}, 1)
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(3 * time.Second))
		if _, err := clientIPC.Recv(); err == nil {
			consulted <- struct{}{}
		}
	}()
	go session.RecvLoop(func(s *sessionbroker.Session, env *ipc.Envelope) {})

	h := newTestHeartbeat(newTestBrokerWithSessions(t, session))
	go func() {
		_, _ = h.executor.Execute(executor.ScriptExecution{
			ID:         "local-1",
			ScriptType: executor.ScriptTypeBash,
			Script:     "for _ in $(seq 1 600); do sleep 0.1; done",
			Timeout:    120,
		})
	}()
	deadline := time.Now().Add(10 * time.Second)
	for len(h.executor.ListRunning()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("script never registered as running")
		}
		time.Sleep(10 * time.Millisecond)
	}

	result := handleScriptCancel(h, cancelCommand("cmd-local", "local-1", 0))
	_ = session.Close()
	_ = clientIPC.Close()

	if got := outcomeOf(t, result); got != "terminated" {
		t.Fatalf("outcome = %q, want terminated", got)
	}
	select {
	case <-consulted:
		t.Fatal("fanned out to a user helper although the local executor owned the execution")
	default:
	}
}

func TestHelperIPCTimeoutExceedsTheMaximumGrace(t *testing.T) {
	// Max grace is 30s; the helper IPC wait used to be 10s+5s = 15s, so a 30s
	// grace would time out the IPC before the helper finished escalating.
	if got := helperCommandTimeout(scriptCancelHelperTimeoutSeconds); got <= executor.MaxGraceSeconds*time.Second {
		t.Fatalf("helper cancel IPC timeout %v must exceed the %ds max grace", got, executor.MaxGraceSeconds)
	}
}
