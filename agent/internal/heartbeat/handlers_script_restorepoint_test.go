package heartbeat

import (
	"encoding/json"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/systemrestore"
)

const scriptTestRequestID = "5f0c2b7e-8a1d-4c3e-9f2a-6b7c8d9e0f1a"

func scriptPayload(extra map[string]any) map[string]any {
	p := map[string]any{
		"scriptId":       "script-1",
		"content":        "echo hello",
		"language":       "bash",
		"timeoutSeconds": float64(10),
	}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func withScriptBlock(extra map[string]any) map[string]any {
	if extra == nil {
		extra = map[string]any{}
	}
	extra[systemrestore.PayloadKey] = restorePointBlock(scriptTestRequestID, true, "Breeze: run script")
	return scriptPayload(extra)
}

func skipUnlessBash(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("local bash execution test runs on Unix")
	}
}

func runScript(h *Heartbeat, payload map[string]any) tools.CommandResult {
	return handleScript(h, Command{ID: "cmd-script", Type: tools.CmdScript, Payload: payload})
}

// eventLog records the order of checkpoint and IPC events across goroutines.
type eventLog struct {
	mu     sync.Mutex
	events []string
}

func (l *eventLog) add(e string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, e)
}

func (l *eventLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

// newFakeRunAsUserHelper returns a run_as_user helper session whose far end
// answers one script command with a completed result, logging "ipc" the moment
// the command arrives.
func newFakeRunAsUserHelper(t *testing.T, log *eventLog) *sessionbroker.Session {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "rp-helper", []string{"run_as_user"})
	session.WinSessionID = "7"
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(10 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			return
		}
		log.add("ipc")
		nested, _ := json.Marshal(map[string]any{"exitCode": 0, "stdout": "ok"})
		payload, _ := json.Marshal(ipc.IPCCommandResult{CommandID: env.ID, Status: "completed", Result: nested})
		_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeCommandResult, Payload: payload})
	}()
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	t.Cleanup(func() { _ = session.Close(); _ = clientIPC.Close() })
	return session
}

func TestScriptWithNoBlockTakesNoCheckpoint(t *testing.T) {
	skipUnlessBash(t)
	rec := installCheckpointRecorder(t)
	res := runScript(newTestHeartbeat(nil), scriptPayload(nil))
	if res.Status != "completed" {
		t.Fatalf("script did not run: %+v", res)
	}
	if rec.count() != 0 {
		t.Fatalf("attempts = %d, want 0 -- a missing block on script means DISABLED", rec.count())
	}
	if res.RestorePoint != nil {
		t.Fatalf("RestorePoint = %+v, want nil", res.RestorePoint)
	}
}

func TestScriptWithABlockCheckpointsOnceBeforeLocalExecution(t *testing.T) {
	skipUnlessBash(t)
	rec := installCheckpointRecorder(t)
	res := runScript(newTestHeartbeat(nil), withScriptBlock(nil))
	if res.Status != "completed" {
		t.Fatalf("script did not run: %+v", res)
	}
	if rec.count() != 1 {
		t.Fatalf("attempts = %d, want 1", rec.count())
	}
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusCreated || res.RestorePoint.RequestID != scriptTestRequestID {
		t.Fatalf("RestorePoint = %+v, want created for the stamped requestId", res.RestorePoint)
	}
	if rec.requests[0].Label != "Breeze: run script" {
		t.Fatalf("label = %q", rec.requests[0].Label)
	}
}

func TestScriptCheckpointHappensAfterValidationAndBeforeExecution(t *testing.T) {
	// Every refusal before the first mutation must leave the day's one restore
	// point unconsumed AND still answer the request with skipped_no_mutation.
	cases := map[string]map[string]any{
		"malformed secretEnv":        {"secretEnv": "not-an-object"},
		"empty content":              {"content": ""},
		"executor validation":        {"content": "rm -rf /"},
		"unsupported language":       {"language": "ruby"},
		"user run with no helper":    {"runAs": "user"},
		"secret on user-context run": {"runAs": "user", "secretEnv": map[string]any{"API_KEY": "s3cret-value"}},
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			rec := installCheckpointRecorder(t)
			res := runScript(newTestHeartbeat(nil), withScriptBlock(extra))
			if res.Status != "failed" {
				t.Fatalf("expected a refusal, got %+v", res)
			}
			if rec.count() != 0 {
				t.Fatalf("attempts = %d, want 0 when the command is refused", rec.count())
			}
			if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusSkippedNoMutation || res.RestorePoint.RequestID != scriptTestRequestID {
				t.Fatalf("RestorePoint = %+v, want skipped_no_mutation", res.RestorePoint)
			}
		})
	}
}

func TestScriptCheckpointHappensBeforeTheUserHelperHandoff(t *testing.T) {
	// User-context scripts are checkpointed by the SERVICE process, before the
	// IPC handoff -- the helper runs unelevated and could not do it.
	log := &eventLog{}
	rec := installCheckpointRecorder(t)
	rec.onCall = func() { log.add("checkpoint") }
	session := newFakeRunAsUserHelper(t, log)
	h := newTestHeartbeat(newTestBrokerWithSessions(t, session))

	res := runScript(h, withScriptBlock(map[string]any{"runAs": "user"}))
	if res.Status != "completed" {
		t.Fatalf("helper run failed: %+v", res)
	}
	if rec.count() != 1 {
		t.Fatalf("attempts = %d, want 1", rec.count())
	}
	if got := log.snapshot(); len(got) != 2 || got[0] != "checkpoint" || got[1] != "ipc" {
		t.Fatalf("event order = %v, want [checkpoint ipc]", got)
	}
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusCreated {
		t.Fatalf("RestorePoint = %+v", res.RestorePoint)
	}
}

func TestScriptSessionTargetedRunCheckpointsAfterTheHelperIsReady(t *testing.T) {
	// On-demand (RDS) path: lease + wait-for-ready are session SELECTION, so
	// the checkpoint follows them, precedes the IPC send, and the lease gets
	// the checkpoint's allowance on top of the script's.
	log := &eventLog{}
	rec := installCheckpointRecorder(t)
	rec.onCall = func() { log.add("checkpoint") }
	session := newFakeRunAsUserHelper(t, log)
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleUser}
	f := &fakeLifecycle{
		mode:        "on-demand",
		waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{key: {Status: sessionbroker.HelperWaitReady, Session: session}},
	}
	h := newTestHeartbeat(sessionbroker.New("/tmp/test-broker-rp-target.sock", nil))
	h.helperLifecycle = f

	res := runScript(h, withScriptBlock(map[string]any{"runAs": "user", "targetSessionId": float64(7), "language": "powershell"}))
	if res.Status != "completed" {
		t.Fatalf("targeted run failed: %+v", res)
	}
	if got := log.snapshot(); len(got) != 2 || got[0] != "checkpoint" || got[1] != "ipc" {
		t.Fatalf("event order = %v, want [checkpoint ipc]", got)
	}
	if len(f.acquiredTTLs) != 1 || f.acquiredTTLs[0] != 5*time.Minute+restorePointBudget {
		t.Fatalf("lease ttls = %v, want the 5m floor plus restorePointBudget", f.acquiredTTLs)
	}
}

func TestScriptSessionTargetedRunWithoutBlockKeepsTheLeaseTTL(t *testing.T) {
	session := newFakeRunAsUserHelper(t, &eventLog{})
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleUser}
	f := &fakeLifecycle{
		mode:        "on-demand",
		waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{key: {Status: sessionbroker.HelperWaitReady, Session: session}},
	}
	h := newTestHeartbeat(sessionbroker.New("/tmp/test-broker-rp-target-noblock.sock", nil))
	h.helperLifecycle = f
	installCheckpointRecorder(t)
	runScript(h, scriptPayload(map[string]any{"runAs": "user", "targetSessionId": float64(7), "language": "powershell"}))
	if len(f.acquiredTTLs) != 1 || f.acquiredTTLs[0] != 5*time.Minute {
		t.Fatalf("lease ttls = %v, want the unchanged 5m floor", f.acquiredTTLs)
	}
}

func TestScriptSessionTargetedWaitFailureReportsNoMutation(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleUser}
	f := &fakeLifecycle{
		mode:        "on-demand",
		waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{key: {Status: sessionbroker.HelperWaitFatalCooldown, RetryAfter: time.Minute}},
	}
	h := newTestHeartbeat(sessionbroker.New("/tmp/test-broker-rp-target-wait.sock", nil))
	h.helperLifecycle = f
	rec := installCheckpointRecorder(t)
	res := runScript(h, withScriptBlock(map[string]any{"runAs": "user", "targetSessionId": float64(7), "language": "powershell"}))
	if rec.count() != 0 || res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusSkippedNoMutation {
		t.Fatalf("attempts = %d, RestorePoint = %+v", rec.count(), res.RestorePoint)
	}
}

func TestScriptHelperWithoutRunAsUserScopeTakesNoCheckpoint(t *testing.T) {
	rec := installCheckpointRecorder(t)
	serverConn, clientConn := createTestSocketPair(t)
	defer func() { _ = clientConn.Close() }()
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "u", "quartz", "noscope", []string{"notify"})
	defer func() { _ = session.Close() }()
	cp := newCommandCheckpoint(withScriptBlock(nil), false, "x")
	res := newTestHeartbeat(nil).executeViaUserHelper(session, Command{ID: "c", Type: tools.CmdScript, Payload: scriptPayload(nil)}, 10, cp)
	if res.Status != "failed" || rec.count() != 0 {
		t.Fatalf("status = %s, attempts = %d", res.Status, rec.count())
	}
}

func TestScriptHelperSendFailureAfterTheCheckpointStillReportsIt(t *testing.T) {
	// The checkpoint precedes the IPC send; if the send then fails, the point
	// genuinely exists and must be reported as taken, not lost and not
	// relabelled skipped_no_mutation.
	rec := installCheckpointRecorder(t)
	serverConn, clientConn := createTestSocketPair(t)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "u", "quartz", "send-fail", []string{"run_as_user"})
	_ = clientConn.Close()
	_ = session.Close() // the send fails: the helper is gone
	h := newTestHeartbeat(newTestBrokerWithSessions(t, session))

	res := runScript(h, withScriptBlock(map[string]any{"runAs": "user"}))
	if res.Status != "failed" {
		t.Fatalf("expected the IPC failure, got %+v", res)
	}
	if rec.count() != 1 {
		t.Fatalf("attempts = %d, want 1", rec.count())
	}
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusCreated {
		t.Fatalf("RestorePoint = %+v, want the created outcome", res.RestorePoint)
	}
}

func TestScriptRedeliveredWhileRunningReportsNoOutcome(t *testing.T) {
	// The server can redeliver a running script's command after the agent's
	// 2-minute dedup window. The executor refuses the duplicate before its
	// boundary; that refusal must NOT answer the request, or its
	// skipped_no_mutation would win the ledger CAS over the original run's
	// real outcome.
	skipUnlessBash(t)
	rec := installCheckpointRecorder(t)
	started := make(chan struct{})
	rec.onCall = func() { close(started) }
	h := newTestHeartbeat(nil)

	firstDone := make(chan tools.CommandResult, 1)
	go func() { firstDone <- runScript(h, withScriptBlock(map[string]any{"content": "sleep 2"})) }()
	<-started // the first run has reached its boundary (and holds the id)

	second := runScript(h, withScriptBlock(map[string]any{"content": "sleep 2"}))
	if second.Status != "failed" {
		t.Fatalf("duplicate = %+v, want the already-running refusal", second)
	}
	if second.RestorePoint != nil {
		t.Fatalf("duplicate RestorePoint = %+v, want nil -- the original run owns the outcome", second.RestorePoint)
	}
	first := <-firstDone
	if first.RestorePoint == nil || first.RestorePoint.Status != systemrestore.StatusCreated {
		t.Fatalf("original RestorePoint = %+v, want created", first.RestorePoint)
	}
	if rec.count() != 1 {
		t.Fatalf("attempts = %d, want 1", rec.count())
	}
}

func TestScriptCheckpointDoesNotConsumeTheScriptTimeoutBudget(t *testing.T) {
	// The checkpoint allowance must not come out of the script's own
	// timeoutSeconds: a 1.5s checkpoint before a 1s-timeout script that
	// finishes instantly must not time the script out.
	skipUnlessBash(t)
	rec := installCheckpointRecorder(t)
	rec.onCall = func() { time.Sleep(1500 * time.Millisecond) }
	res := runScript(newTestHeartbeat(nil), withScriptBlock(map[string]any{"timeoutSeconds": float64(1)}))
	if res.Status != "completed" {
		t.Fatalf("result = %+v: the checkpoint consumed the script's timeout budget", res)
	}
}

func TestReplayedCommandProducesOneLedgerOutcomePerRequestID(t *testing.T) {
	// The agent's dedup map is in-memory and evicted after two minutes, so a
	// crash can replay both the checkpoint and the risky action. The requestId
	// is what makes the ledger row idempotent (the server's CAS on
	// status='requested' accepts only the first): assert the agent reuses the
	// SAME server-stamped requestId on replay rather than minting one.
	skipUnlessBash(t)
	installCheckpointRecorder(t)
	h := newTestHeartbeat(nil)
	first := runScript(h, withScriptBlock(nil))
	second := runScript(h, withScriptBlock(nil))
	if first.RestorePoint == nil || second.RestorePoint == nil {
		t.Fatalf("missing outcome: %+v / %+v", first.RestorePoint, second.RestorePoint)
	}
	if first.RestorePoint.RequestID != scriptTestRequestID || second.RestorePoint.RequestID != scriptTestRequestID {
		t.Fatalf("replay minted a new requestId: %q then %q",
			first.RestorePoint.RequestID, second.RestorePoint.RequestID)
	}
}

// newHeldRunAsUserHelper returns a run_as_user helper session whose far end
// signals arrived when the first script command reaches it and answers that
// command only once release is closed — a user-context script still running in
// the helper. Any later command is answered immediately.
func newHeldRunAsUserHelper(t *testing.T, arrived chan<- struct{}, release <-chan struct{}) *sessionbroker.Session {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "rp-held-helper", []string{"run_as_user"})
	session.WinSessionID = "7"
	go func() {
		for first := true; ; first = false {
			_ = clientIPC.SetReadDeadline(time.Now().Add(10 * time.Second))
			env, err := clientIPC.Recv()
			if err != nil {
				return
			}
			if first {
				close(arrived)
				<-release
			}
			nested, _ := json.Marshal(map[string]any{"exitCode": 0, "stdout": "ok"})
			payload, _ := json.Marshal(ipc.IPCCommandResult{CommandID: env.ID, Status: "completed", Result: nested})
			_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeCommandResult, Payload: payload})
		}
	}()
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	t.Cleanup(func() { _ = session.Close(); _ = clientIPC.Close() })
	return session
}

func TestScriptRedeliveredToTheUserHelperWhileRunningReportsNoOutcome(t *testing.T) {
	// #9164: the user-helper mirror of TestScriptRedeliveredWhileRunningReportsNoOutcome.
	// The service process checkpoints before the IPC handoff, so a redelivery
	// of a command still running in the helper must be refused BEFORE that
	// boundary — otherwise it takes a second checkpoint (existing_accepted on a
	// real host, inside System Restore's frequency window) and its answer races
	// the original run's outcome for the ledger row.
	rec := installCheckpointRecorder(t)
	arrived := make(chan struct{})
	release := make(chan struct{})
	session := newHeldRunAsUserHelper(t, arrived, release)
	h := newTestHeartbeat(newTestBrokerWithSessions(t, session))
	payload := func() map[string]any { return withScriptBlock(map[string]any{"runAs": "user"}) }

	firstDone := make(chan tools.CommandResult, 1)
	go func() { firstDone <- runScript(h, payload()) }()
	select {
	case <-arrived: // checkpointed, handed off, still running in the helper
	case <-time.After(5 * time.Second):
		t.Fatal("first delivery never reached the helper")
	}

	second := runScript(h, payload())
	close(release)
	first := <-firstDone

	if second.Status != "failed" {
		t.Fatalf("duplicate = %+v, want the already-running refusal", second)
	}
	if second.RestorePoint != nil {
		t.Fatalf("duplicate RestorePoint = %+v, want nil -- the original run owns the outcome", second.RestorePoint)
	}
	if rec.count() != 1 {
		t.Fatalf("attempts = %d, want 1 -- a redelivery must not take a second checkpoint", rec.count())
	}
	if first.Status != "completed" || first.RestorePoint == nil || first.RestorePoint.Status != systemrestore.StatusCreated {
		t.Fatalf("original = %+v (RestorePoint %+v), want completed with the created outcome", first, first.RestorePoint)
	}

	// The reservation is per execution, not forever: once the original run has
	// answered, a later delivery of the id is handled normally (the heartbeat's
	// own dedup window is what governs replays after completion).
	third := runScript(h, payload())
	if third.Status != "completed" {
		t.Fatalf("delivery after completion = %+v, want it run normally", third)
	}
}

func TestScriptSessionTargetedRedeliveryLeavesTheOriginalLeaseAndCheckpoint(t *testing.T) {
	// #9164, on-demand (RDS) path: the duplicate must be refused before it
	// touches the lease. Leases are owned per opID (= command id), so a
	// duplicate that acquired and then released "its" lease dropped the
	// ORIGINAL run's ownership while that script was still running.
	rec := installCheckpointRecorder(t)
	arrived := make(chan struct{})
	release := make(chan struct{})
	session := newHeldRunAsUserHelper(t, arrived, release)
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleUser}
	f := &fakeLifecycle{
		mode:        "on-demand",
		waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{key: {Status: sessionbroker.HelperWaitReady, Session: session}},
	}
	h := newTestHeartbeat(sessionbroker.New("/tmp/test-broker-rp-target-dup.sock", nil))
	h.helperLifecycle = f
	payload := func() map[string]any {
		return withScriptBlock(map[string]any{"runAs": "user", "targetSessionId": float64(7), "language": "powershell"})
	}

	firstDone := make(chan tools.CommandResult, 1)
	go func() { firstDone <- runScript(h, payload()) }()
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("first delivery never reached the helper")
	}

	second := runScript(h, payload())
	f.mu.Lock()
	acquired, released := len(f.acquired), len(f.released)
	f.mu.Unlock()
	close(release)
	first := <-firstDone

	if second.Status != "failed" || second.RestorePoint != nil {
		t.Fatalf("duplicate = %+v (RestorePoint %+v), want a refusal with no outcome", second, second.RestorePoint)
	}
	if acquired != 1 || released != 0 {
		t.Fatalf("while the original ran: leases acquired = %d, released = %d; want 1 and 0", acquired, released)
	}
	if rec.count() != 1 {
		t.Fatalf("attempts = %d, want 1", rec.count())
	}
	if first.Status != "completed" || first.RestorePoint == nil || first.RestorePoint.Status != systemrestore.StatusCreated {
		t.Fatalf("original = %+v (RestorePoint %+v)", first, first.RestorePoint)
	}
}
