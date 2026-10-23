package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #8995: once a server-approved elevation has launched the target as
// ~breeze_elev, the user's original UAC credential prompt must be dismissed —
// that prompt and no other.

const approvedTestRequestID = "40000000-0000-4000-8000-000000000001" // pamApplyV2TestCommand's requestId

var approvedTestConsent = etwlua.ConsentInstance{PID: 5152, CreatedAt: time.Date(2026, 10, 17, 3, 3, 17, 123456700, time.UTC)}

type targetedDismissCall struct {
	session  *sessionbroker.Session
	id       string
	instance ipc.PamConsentInstance
	timeout  time.Duration
}

type approvedConsentRig struct {
	h        *Heartbeat
	manager  *fakePamLifetimeManager
	session  *sessionbroker.Session
	finds    []string
	calls    []targetedDismissCall
	result   ipc.PamDismissConsentResult
	err      error
	untarget int
}

func newApprovedConsentRig(t *testing.T, applyState pamlifetime.ResultState) *approvedConsentRig {
	t.Helper()
	applied := pamReceivedTestObservation()
	applied.State = applyState
	if applyState == pamlifetime.ResultFailed {
		applied.FailureCode = "account_promotion_failed"
	}
	rig := &approvedConsentRig{
		manager: &fakePamLifetimeManager{applyResult: applied, available: true},
		session: &sessionbroker.Session{SessionID: "pam-helper-42", WinSessionID: "42", SupportsTargetedPamDismiss: true},
		result:  ipc.PamDismissConsentResult{Success: true, Reason: "ok"},
	}
	rig.h = readyPamApplyTestHeartbeat(rig.manager, newPamReconciliationOutbox(t.TempDir()))
	rig.h.pamFindSession = func(capability, target string) *sessionbroker.Session {
		if capability != ipc.ScopePam {
			t.Fatalf("capability = %q, want %q", capability, ipc.ScopePam)
		}
		rig.finds = append(rig.finds, target)
		return rig.session
	}
	rig.h.pamDismissConsentInstance = func(s *sessionbroker.Session, id string, inst ipc.PamConsentInstance, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
		rig.calls = append(rig.calls, targetedDismissCall{session: s, id: id, instance: inst, timeout: timeout})
		return rig.result, rig.err
	}
	rig.h.pamDismissConsent = func(*sessionbroker.Session, string, time.Duration) (ipc.PamDismissConsentResult, error) {
		rig.untarget++
		return ipc.PamDismissConsentResult{Success: true, Reason: "ok"}, nil
	}
	return rig
}

func (r *approvedConsentRig) apply(t *testing.T) {
	t.Helper()
	res := handlePamApplyV2(r.h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
	if res.Status != "completed" {
		t.Fatalf("pam_apply_v2 status = %q (%s)", res.Status, res.Error)
	}
}

func TestPamApplyV2VerifiedLaunchDismissesTheRecordedConsentOnce(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)

	rig.apply(t)
	// A redelivered or re-generated apply for the same request must not
	// dismiss again: the recorded prompt is consumed by the first attempt.
	rig.apply(t)

	if len(rig.calls) != 1 {
		t.Fatalf("targeted dismissals = %d, want exactly 1", len(rig.calls))
	}
	call := rig.calls[0]
	want := ipc.PamConsentInstance{PID: approvedTestConsent.PID, CreatedUnixNano: approvedTestConsent.CreatedAt.UnixNano()}
	if call.instance != want {
		t.Fatalf("dismissed instance = %+v, want %+v", call.instance, want)
	}
	if call.session != rig.session {
		t.Fatalf("dismissal went to session %p, want the requester-session helper %p", call.session, rig.session)
	}
	if len(rig.finds) != 1 || rig.finds[0] != "42" {
		t.Fatalf("helper lookups = %q, want one lookup in the recorded session 42", rig.finds)
	}
	if call.id == approvedTestRequestID || call.id == "" {
		t.Fatalf("dismiss IPC id = %q; must be distinct from the elevation request id", call.id)
	}
	if call.timeout != pamDismissTimeout {
		t.Fatalf("dismiss timeout = %v, want %v", call.timeout, pamDismissTimeout)
	}
	if rig.untarget != 0 {
		t.Fatalf("untargeted dismissals = %d, want 0 — it could cancel an unrelated prompt", rig.untarget)
	}
}

func TestPamApplyV2LaunchFailureLeavesTheConsentPrompt(t *testing.T) {
	for _, state := range []pamlifetime.ResultState{pamlifetime.ResultFailed, pamlifetime.ResultReceived} {
		t.Run(string(state), func(t *testing.T) {
			rig := newApprovedConsentRig(t, state)
			rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)

			rig.apply(t)

			if len(rig.calls) != 0 || rig.untarget != 0 || len(rig.finds) != 0 {
				t.Fatalf("dismissed after an unverified launch: targeted=%d untargeted=%d finds=%d",
					len(rig.calls), rig.untarget, len(rig.finds))
			}
			// The prompt is still the user's fallback, and a later successful
			// apply for the same request must still be able to clean it up.
			if _, ok := rig.h.pamPendingConsents.peek(approvedTestRequestID); !ok {
				t.Fatal("recorded consent instance dropped after a failed launch")
			}
			rig.manager.applyResult.State = pamlifetime.ResultVerifiedActive
			rig.manager.applyResult.FailureCode = ""
			rig.apply(t)
			if len(rig.calls) != 1 {
				t.Fatalf("targeted dismissals after the retry launched = %d, want 1", len(rig.calls))
			}
		})
	}
}

func TestPamApplyV2WithoutRecordedConsentDismissesNothing(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	// e.g. the agent restarted since interception, or attribution fell back
	// to the console session and no consent.exe was identified.
	rig.apply(t)
	if len(rig.calls) != 0 || rig.untarget != 0 {
		t.Fatalf("dismissed with no recorded prompt: targeted=%d untargeted=%d", len(rig.calls), rig.untarget)
	}
}

func TestApprovedConsentDismissalNeverCrossesSessions(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	rig.session.WinSessionID = "7"
	rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)

	rig.apply(t)
	if len(rig.calls) != 0 {
		t.Fatalf("dismissal sent to a helper in session %q for a prompt in session 42", rig.session.WinSessionID)
	}
}

func TestApprovedConsentDismissalNoHelperIsTolerated(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	rig.session = nil
	rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)

	rig.apply(t)
	if len(rig.calls) != 0 {
		t.Fatalf("targeted dismissals = %d with no helper", len(rig.calls))
	}
}

func TestApprovedConsentDismissalDefersToAnEngagedGate(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)
	rig.h.pamDismissalUncertain = true // recovery owns the consent desktop

	rig.apply(t)
	if len(rig.calls) != 0 {
		t.Fatal("approved-consent dismissal drove the desktop while the dismissal gate was engaged")
	}
	// Skipping is not giving up: once the gate is released, a redelivered
	// apply for the same request can still close the prompt.
	rig.h.pamDismissalUncertain = false
	rig.apply(t)
	if len(rig.calls) != 1 {
		t.Fatalf("targeted dismissals after the gate cleared = %d, want 1", len(rig.calls))
	}
}

func TestApprovedConsentDismissalUncertaintyDoesNotDisablePam(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	rig.h.pamApprovedConsentQuiesceWait = 20 * time.Millisecond
	rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)
	quiesced := make(chan sessionbroker.PamDismissOutcome) // helper never answers
	rig.err = &sessionbroker.PamDismissUncertainError{Cause: errors.New("command timed out"), Quiesced: quiesced}

	rig.apply(t)
	if len(rig.calls) != 1 {
		t.Fatalf("targeted dismissals = %d, want 1", len(rig.calls))
	}
	rig.h.pamActuateMu.Lock()
	engaged := rig.h.pamDismissalUncertain
	rig.h.pamActuateMu.Unlock()
	if engaged {
		t.Fatal("a cosmetic approved-prompt cleanup engaged the fail-closed PAM gate")
	}
}

// After a broker timeout the helper may still be about to press Escape. The
// actuation lock must stay held until the helper proves it finished (bounded),
// so no other actuation types into a consent prompt while that keystroke can
// still land.
func TestApprovedConsentDismissalHoldsActuationLockUntilHelperQuiesces(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	rig.h.pamApprovedConsentQuiesceWait = 5 * time.Second
	rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)
	quiesced := make(chan sessionbroker.PamDismissOutcome, 1)
	rig.err = &sessionbroker.PamDismissUncertainError{Cause: errors.New("command timed out"), Quiesced: quiesced}

	var helperFinished atomic.Bool
	go func() {
		time.Sleep(100 * time.Millisecond)
		helperFinished.Store(true)
		quiesced <- sessionbroker.PamDismissOutcome{Proven: true, Result: ipc.PamDismissConsentResult{Success: true, Reason: "ok"}}
	}()

	applied := make(chan struct{})
	go func() {
		rig.apply(t)
		close(applied)
	}()

	// Wait until the dismissal is in flight, then contend for the lock the
	// way a concurrent actuateElevation would.
	deadline := time.Now().Add(2 * time.Second)
	for {
		rig.h.pamActuateMu.Lock()
		inFlight := len(rig.calls) == 1
		finished := helperFinished.Load()
		rig.h.pamActuateMu.Unlock()
		if inFlight {
			if !finished {
				t.Fatal("actuation lock was released while the uncertain dismissal could still press Escape")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("dismissal never ran")
		}
		time.Sleep(time.Millisecond)
	}
	<-applied
}

func TestApprovedConsentDismissalRetriesOnlyWhilePromptMayRemain(t *testing.T) {
	for _, tc := range []struct {
		name      string
		result    ipc.PamDismissConsentResult
		err       error
		wantCalls int // after two applies for the same request
	}{
		{"dismissed", ipc.PamDismissConsentResult{Success: true, Reason: "ok"}, nil, 1},
		{"already closed", ipc.PamDismissConsentResult{Reason: "no_consent_window"}, nil, 1},
		{"not foreground", ipc.PamDismissConsentResult{Reason: "consent_not_foreground"}, nil, 2},
		{"did not close", ipc.PamDismissConsentResult{Reason: "consent_did_not_close"}, nil, 2},
		{"older helper", ipc.PamDismissConsentResult{}, sessionbroker.ErrPamTargetedDismissUnsupported, 2},
		{"ipc error", ipc.PamDismissConsentResult{}, errors.New("helper pipe closed"), 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
			rig.result, rig.err = tc.result, tc.err
			rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)
			rig.apply(t)
			rig.apply(t)
			if len(rig.calls) != tc.wantCalls || rig.untarget != 0 {
				t.Fatalf("targeted=%d untargeted=%d, want %d/0", len(rig.calls), rig.untarget, tc.wantCalls)
			}
		})
	}
}

func TestApprovedConsentDismissalNoHelperKeepsTheRecord(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	helper := rig.session
	rig.session = nil
	rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)

	rig.apply(t)
	rig.session = helper // helper reconnects
	rig.apply(t)
	if len(rig.calls) != 1 {
		t.Fatalf("targeted dismissals = %d, want 1 once the helper is back", len(rig.calls))
	}
}

// Two parked requests attributed to the same consent.exe means one of them is
// wrong; dismissing on either approval could close the other request's prompt.
func TestPendingPamConsentsRefuseOneInstanceForTwoRequests(t *testing.T) {
	var reg pendingPamConsents
	reg.record("req-a", "42", approvedTestConsent)
	reg.record("req-b", "42", approvedTestConsent)
	if _, ok := reg.peek("req-a"); ok {
		t.Fatal("req-a kept an instance also claimed by req-b")
	}
	if _, ok := reg.peek("req-b"); ok {
		t.Fatal("req-b kept an instance also claimed by req-a")
	}
	// The same request re-recording its own instance (a re-fired ETW event)
	// is not a conflict.
	reg.record("req-c", "42", etwlua.ConsentInstance{PID: 9, CreatedAt: approvedTestConsent.CreatedAt})
	reg.record("req-c", "42", etwlua.ConsentInstance{PID: 9, CreatedAt: approvedTestConsent.CreatedAt})
	if _, ok := reg.peek("req-c"); !ok {
		t.Fatal("re-recording the same request dropped it")
	}
}

// RunPamFlow is where the request's consent.exe is known; it records it only
// when the flow parks waiting for a technician.
func TestRunPamFlowAwaitRemoteRecordsTheConsentInstance(t *testing.T) {
	cases := []struct {
		name       string
		status     etwlua.ElevationStatus
		session    uint32
		consent    etwlua.ConsentInstance
		dialog     ipc.PamDialogResult
		wantRecord bool
	}{
		{"pending + user continues records the prompt", etwlua.ElevationPending, 42, approvedTestConsent, ipc.PamDialogResult{Approved: true}, true},
		{"no consent identity (console fallback) records nothing", etwlua.ElevationPending, 42, etwlua.ConsentInstance{}, ipc.PamDialogResult{Approved: true}, false},
		{"unresolved session records nothing", etwlua.ElevationPending, 0, approvedTestConsent, ipc.PamDialogResult{Approved: true}, false},
		{"pending + user cancels is a deny, not a wait", etwlua.ElevationPending, 42, approvedTestConsent, ipc.PamDialogResult{DismissedByUser: true}, false},
		{"policy deny records nothing", etwlua.ElevationDenied, 42, approvedTestConsent, ipc.PamDialogResult{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &Heartbeat{}
			h.pamFindSession = func(string, string) *sessionbroker.Session {
				return &sessionbroker.Session{SessionID: "pam-helper", WinSessionID: "42"}
			}
			h.pamRequestDialog = func(*sessionbroker.Session, string, ipc.PamRequestDialog, time.Duration) (ipc.PamDialogResult, error) {
				return tc.dialog, nil
			}
			h.pamDismissConsent = func(*sessionbroker.Session, string, time.Duration) (ipc.PamDismissConsentResult, error) {
				return ipc.PamDismissConsentResult{Success: true, Reason: "ok"}, nil
			}
			ev := etwlua.Event{SubjectUsername: `CORP\alice`, SubjectSessionID: tc.session, Consent: tc.consent,
				TargetExecutablePath: `C:\Windows\System32\notepad.exe`}

			h.RunPamFlow(context.Background(), ev, etwlua.ElevationOutcome{RequestID: approvedTestRequestID, Status: tc.status})

			got, ok := h.pamPendingConsents.peek(approvedTestRequestID)
			if ok != tc.wantRecord {
				t.Fatalf("recorded = %v, want %v", ok, tc.wantRecord)
			}
			if ok && (got.winSession != "42" || got.instance != tc.consent) {
				t.Fatalf("recorded %+v, want session 42 instance %+v", got, tc.consent)
			}
		})
	}
}

func TestPendingPamConsentsAreBounded(t *testing.T) {
	now := time.Date(2026, 10, 17, 3, 0, 0, 0, time.UTC)
	var reg pendingPamConsents
	reg.now = func() time.Time { return now }

	instance := func(i int) etwlua.ConsentInstance {
		return etwlua.ConsentInstance{PID: uint32(1000 + i), CreatedAt: approvedTestConsent.CreatedAt}
	}
	for i := 0; i < maxPendingPamConsents+5; i++ {
		reg.record(fmt.Sprintf("req-%03d", i), "1", instance(i))
		now = now.Add(time.Second)
	}
	if n := reg.len(); n != maxPendingPamConsents {
		t.Fatalf("entries = %d, want cap %d", n, maxPendingPamConsents)
	}
	for i := 0; i < 5; i++ {
		if _, ok := reg.peek(fmt.Sprintf("req-%03d", i)); ok {
			t.Fatalf("req-%03d (among the oldest) survived past the cap", i)
		}
	}
	if _, ok := reg.peek(fmt.Sprintf("req-%03d", maxPendingPamConsents+4)); !ok {
		t.Fatal("newest entry was evicted")
	}

	reg.record("fresh", "1", approvedTestConsent)
	now = now.Add(pendingPamConsentTTL + time.Second)
	if _, ok := reg.take("fresh"); ok {
		t.Fatal("an entry older than the TTL was handed out")
	}
}
