package heartbeat

import (
	"context"
	"errors"
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
}

func TestApprovedConsentDismissalUncertaintyDoesNotDisablePam(t *testing.T) {
	rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
	rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)
	quiesced := make(chan sessionbroker.PamDismissOutcome)
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

func TestApprovedConsentDismissalToleratesHelperResults(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result ipc.PamDismissConsentResult
		err    error
	}{
		{"already closed", ipc.PamDismissConsentResult{Reason: "no_consent_window"}, nil},
		{"not foreground", ipc.PamDismissConsentResult{Reason: "consent_not_foreground"}, nil},
		{"older helper", ipc.PamDismissConsentResult{}, sessionbroker.ErrPamTargetedDismissUnsupported},
		{"ipc error", ipc.PamDismissConsentResult{}, errors.New("helper pipe closed")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newApprovedConsentRig(t, pamlifetime.ResultVerifiedActive)
			rig.result, rig.err = tc.result, tc.err
			rig.h.recordPendingPamConsent(approvedTestRequestID, "42", approvedTestConsent)
			rig.apply(t)
			if len(rig.calls) != 1 || rig.untarget != 0 {
				t.Fatalf("targeted=%d untargeted=%d, want 1/0", len(rig.calls), rig.untarget)
			}
		})
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

	for i := 0; i < maxPendingPamConsents+5; i++ {
		reg.record(string(rune('a'+i%26))+time.Duration(i).String(), "1", approvedTestConsent)
		now = now.Add(time.Second)
	}
	if n := reg.len(); n != maxPendingPamConsents {
		t.Fatalf("entries = %d, want cap %d", n, maxPendingPamConsents)
	}
	if _, ok := reg.peek("a0s"); ok {
		t.Fatal("oldest entry survived past the cap")
	}

	reg.record("fresh", "1", approvedTestConsent)
	now = now.Add(pendingPamConsentTTL + time.Second)
	if _, ok := reg.take("fresh"); ok {
		t.Fatal("an entry older than the TTL was handed out")
	}
}
