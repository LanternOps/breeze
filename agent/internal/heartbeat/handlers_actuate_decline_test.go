package heartbeat

import (
	"context"
	"encoding/json"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/pamdecline"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// #8971: both apply paths honour the end user's answer. pam_apply_v2 waits
// (bounded, outside any lock) while the dialog is still open, then the
// lifetime manager's own non-blocking check refuses a declined request with
// a real boot id (the server requires evidence.bootId). The legacy
// actuate_elevation path refuses before admission.

const declineApplyReq = "40000000-0000-4000-8000-000000000001" // pamApplyV2TestCommand's requestId

// declineAwareManager stands in for the lifetime manager: like the real one it
// consults the installed checker before doing any work.
type declineAwareManager struct {
	*fakePamLifetimeManager
	mu      sync.Mutex
	checker pamlifetime.DeclineChecker
	entered int
}

func (m *declineAwareManager) SetDeclineChecker(c pamlifetime.DeclineChecker) {
	m.mu.Lock()
	m.checker = c
	m.mu.Unlock()
}

func (m *declineAwareManager) ApplyWithReceivedObservation(_ context.Context, cmd pamlifetime.ApplyCommand, _ func(pamlifetime.Result) error) pamlifetime.Result {
	m.mu.Lock()
	m.entered++
	checker := m.checker
	m.mu.Unlock()
	res := pamReceivedTestObservation()
	res.Evidence.BootID = "windows-boot-42"
	if checker != nil {
		if refuse, code := checker.Check(cmd.RequestID); refuse {
			res.State = pamlifetime.ResultFailed
			res.FailureCode = code
			return res
		}
	}
	res.State = pamlifetime.ResultVerifiedActive
	return res
}

func (m *declineAwareManager) enteredCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.entered
}

func newDeclineApplyRig(t *testing.T) (*Heartbeat, *declineAwareManager, *pamdecline.Store) {
	t.Helper()
	manager := &declineAwareManager{fakePamLifetimeManager: &fakePamLifetimeManager{available: true}}
	h := readyPamApplyTestHeartbeat(manager, newPamReconciliationOutbox(t.TempDir()))
	store := pamdecline.NewStore("", nil)
	h.pamDeclines = store
	manager.SetDeclineChecker(pamDeclineChecker{h})
	return h, manager, store
}

func applyResultOf(t *testing.T, res tools.CommandResult) pamlifetime.Result {
	t.Helper()
	r, ok := res.Result.(pamlifetime.Result)
	if !ok {
		t.Fatalf("command result = %+v, want a pamlifetime.Result", res)
	}
	return r
}

func runApplyAsync(h *Heartbeat) <-chan tools.CommandResult {
	done := make(chan tools.CommandResult, 1)
	go func() { done <- handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000008971")) }()
	return done
}

func TestApplyRefusesDeclinedRequestV2(t *testing.T) {
	h, manager, store := newDeclineApplyRig(t)
	if err := store.Decline(declineApplyReq, pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}

	r := applyResultOf(t, handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000008971")))

	if r.State != pamlifetime.ResultFailed || r.FailureCode != pamdecline.CodeUserDeclined {
		t.Fatalf("result = %+v, want failed/user_declined", r)
	}
	if r.Evidence.BootID == "" {
		t.Fatal("refusal carries no boot id; the server rejects that")
	}
	if manager.enteredCount() != 1 {
		t.Fatalf("manager entered %d times, want 1", manager.enteredCount())
	}
}

func TestApplyWaitsForOpenDialogThenRefusesOnDeny(t *testing.T) {
	h, manager, store := newDeclineApplyRig(t)
	if _, err := store.BeginAwaiting(declineApplyReq, "pending"); err != nil {
		t.Fatal(err)
	}

	done := runApplyAsync(h)
	select {
	case res := <-done:
		t.Fatalf("apply returned %+v while the dialog was still open", res)
	case <-time.After(50 * time.Millisecond):
	}
	if n := manager.enteredCount(); n != 0 {
		t.Fatalf("manager entered %d times before the user answered", n)
	}

	if err := store.Decline(declineApplyReq, pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-done:
		r := applyResultOf(t, res)
		if r.State != pamlifetime.ResultFailed || r.FailureCode != pamdecline.CodeUserDeclined {
			t.Fatalf("result = %+v, want failed/user_declined", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("apply did not return after the user declined")
	}
}

func TestApplyWaitsForOpenDialogThenProceedsOnApprove(t *testing.T) {
	h, manager, store := newDeclineApplyRig(t)
	if _, err := store.BeginAwaiting(declineApplyReq, "pending"); err != nil {
		t.Fatal(err)
	}

	done := runApplyAsync(h)
	time.Sleep(50 * time.Millisecond)
	if n := manager.enteredCount(); n != 0 {
		t.Fatalf("manager entered %d times before the user answered", n)
	}
	if err := store.Consent(declineApplyReq); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-done:
		r := applyResultOf(t, res)
		if r.State != pamlifetime.ResultVerifiedActive {
			t.Fatalf("result = %+v, want verified_active", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("apply did not return after the user approved")
	}
	if n := manager.enteredCount(); n != 1 {
		t.Fatalf("manager entered %d times, want 1", n)
	}
}

func TestApplyWaitTimesOut(t *testing.T) {
	h, _, store := newDeclineApplyRig(t)
	h.pamDeclineWait = 100 * time.Millisecond
	if _, err := store.BeginAwaiting(declineApplyReq, "pending"); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	r := applyResultOf(t, handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000008971")))

	if r.State != pamlifetime.ResultFailed || r.FailureCode != pamdecline.CodeUserDecisionPending {
		t.Fatalf("result = %+v, want failed/user_decision_pending", r)
	}
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Fatalf("returned after %v, before the wait bound", elapsed)
	}
}

func TestApplyWaitDefaultsToDialogPlusDismiss(t *testing.T) {
	if got := (&Heartbeat{}).pamDeclineWaitBound(); got != pamDialogTimeout+pamDismissTimeout {
		t.Fatalf("wait bound = %v, want %v", got, pamDialogTimeout+pamDismissTimeout)
	}
}

func TestActuateElevationRefusesDeclined(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyLegacyHeartbeat(manager)
	h.pamDeclines = pamdecline.NewStore("", nil)
	if err := h.pamDeclines.Decline("cccccccc-cccc-4ccc-8ccc-cccccccccccc", pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	constructed := false
	swapElevationManagerForTest(t, func() elevaccount.AccountManager {
		constructed = true
		return &fakeElevationManager{}
	})
	calls := swapPAMEventLogWritersForTest(t)

	res := handleActuateElevation(h, Command{Payload: map[string]any{
		"elevationRequestId": "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC",
		"targetPath":         `C:\Temp\setup.exe`,
	}})

	var out actuateResult
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		t.Fatalf("result = %+v, want an actuateResult in Stdout: %v", res, err)
	}
	if out.Success || out.Reason != pamdecline.CodeUserDeclined {
		t.Fatalf("actuate result = %+v, want success=false reason=user_declined", out)
	}
	if constructed {
		t.Error("an elevation account manager was constructed for a declined request")
	}
	if manager.leaseCalls != 0 {
		t.Errorf("legacy admission acquired %d times for a declined request", manager.leaseCalls)
	}
	if got := stageNames(*calls); len(got) != 1 || got[0] != "actuation_refused" {
		t.Errorf("event log stages = %v, want [actuation_refused]", got)
	}
}

// declineDuringAdmissionManager records a decline while the legacy handler
// waits for admission, i.e. after its first (waiting) check passed.
type declineDuringAdmissionManager struct {
	*fakePamLifetimeManager
	onAcquire func()
}

func (m *declineDuringAdmissionManager) AcquireLegacyActuation(ctx context.Context) (func(), error) {
	m.onAcquire()
	return m.fakePamLifetimeManager.AcquireLegacyActuation(ctx)
}

func TestActuateElevationRechecksAfterAdmission(t *testing.T) {
	inner := &fakePamLifetimeManager{available: true}
	store := pamdecline.NewStore("", nil)
	const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	manager := &declineDuringAdmissionManager{fakePamLifetimeManager: inner, onAcquire: func() {
		if err := store.Decline(id, pamdecline.ReasonUserDenied); err != nil {
			t.Fatal(err)
		}
	}}
	h := &Heartbeat{pamLifetimeManager: manager, pamDeclines: store}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)
	h.uacInterceptionEnabled.Store(true)
	account := &fakeElevationManager{cred: elevaccount.Credential{Username: elevaccount.AccountName, Password: "secret"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return account })
	calls := swapPAMEventLogWritersForTest(t)

	res := handleActuateElevation(h, Command{Payload: map[string]any{"elevationRequestId": id}})

	var out actuateResult
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		t.Fatalf("result = %+v: %v", res, err)
	}
	if out.Success || out.Reason != pamdecline.CodeUserDeclined {
		t.Fatalf("actuate result = %+v, want refused user_declined", out)
	}
	if account.promoteSeen != 0 {
		t.Fatalf("account promoted %d times after the decline", account.promoteSeen)
	}
	if got := stageNames(*calls); len(got) != 1 || got[0] != "actuation_refused" {
		t.Errorf("event log stages = %v, want [actuation_refused]", got)
	}
}

func TestActuateElevationUnaffectedForOtherRequest(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyLegacyHeartbeat(manager)
	h.pamDeclines = pamdecline.NewStore("", nil)
	if err := h.pamDeclines.Decline("dddddddd-dddd-4ddd-8ddd-dddddddddddd", pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	account := &fakeElevationManager{cred: elevaccount.Credential{Username: elevaccount.AccountName, Password: "secret"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return account })

	res := handleActuateElevation(h, Command{Payload: map[string]any{"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}})

	var out actuateResult
	_ = json.Unmarshal([]byte(res.Stdout), &out)
	if out.Reason == pamdecline.CodeUserDeclined {
		t.Fatalf("another request's decline refused this actuation: %+v", out)
	}
	if manager.leaseCalls != 1 {
		t.Fatalf("legacy admission acquired %d times, want 1", manager.leaseCalls)
	}
}

// SetStatePath wires the file-backed store into the real lifetime manager, so
// a decline recorded through the heartbeat refuses the manager's apply.
func TestSetStatePathInstallsDeclineChecker(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows manager needs a real boot id; the wiring is the same")
	}
	dir := t.TempDir()
	h := &Heartbeat{}
	h.SetStatePath(filepath.Join(dir, "agent-state.json"))
	if got := h.pamDeclineStore().Path(); got != filepath.Join(dir, pamDeclineFileName) {
		t.Fatalf("decline store path = %q", got)
	}
	if err := h.pamDeclineStore().Decline(declineApplyReq, pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	cmd := pamlifetime.ApplyCommand{ProtocolVersion: 2, ActuationID: "30000000-0000-4000-8000-000000000001", Generation: 1,
		RequestID: declineApplyReq, DeviceID: "10000000-0000-4000-8000-000000000003", OrgID: "10000000-0000-4000-8000-000000000004",
		TargetPath: `C:\Windows\System32\mmc.exe`, SubjectUsername: `CORP\alice`, ExpiresAt: time.Now().Add(time.Minute),
		ServerTime: time.Now(), MaxRemainingLifetimeMS: 60000}

	res := h.pamLifetimeManager.Apply(context.Background(), cmd)

	if res.State != pamlifetime.ResultFailed || res.FailureCode != pamdecline.CodeUserDeclined {
		t.Fatalf("result = %+v, want failed/user_declined", res)
	}
}
