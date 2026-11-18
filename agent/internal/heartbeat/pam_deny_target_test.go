package heartbeat

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #10370: on a dialog timeout the agent pressed an untargeted Escape while
// its own topmost "Elevation Request" dialog was still open, so the Escape
// closed that dialog and the UAC prompt stayed up. The deny path must take
// the dialog down first and aim the dismissal at the request's own
// consent.exe when it knows it.

// denyRig records, in order, what the deny path did at the helper.
type denyRig struct {
	mu     sync.Mutex
	events []string

	closeDialogID string
	closeID       string
	dismissID     string
	instanceID    string
	instance      ipc.PamConsentInstance
}

func (r *denyRig) add(ev string) {
	r.mu.Lock()
	r.events = append(r.events, ev)
	r.mu.Unlock()
}

func (r *denyRig) got() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

var testConsent = etwlua.ConsentInstance{PID: 4242, CreatedAt: time.Unix(1_700_000_000, 123_456_789)}

// newDenyRig builds a Heartbeat whose PAM seams all report into the rig.
// dialogErr is what the dialog round-trip returns.
func newDenyRig(t *testing.T, session *sessionbroker.Session, dialog ipc.PamDialogResult, dialogErr error) (*Heartbeat, *denyRig) {
	t.Helper()
	r := &denyRig{}
	h := &Heartbeat{
		pamFindSession: func(string, string) *sessionbroker.Session { return session },
		pamRequestDialog: func(*sessionbroker.Session, string, ipc.PamRequestDialog, time.Duration) (ipc.PamDialogResult, error) {
			r.add("dialog")
			return dialog, dialogErr
		},
		pamCloseDialog: func(_ *sessionbroker.Session, id, dialogID string, _ time.Duration) (ipc.PamCloseDialogResult, error) {
			r.add("close_dialog")
			r.mu.Lock()
			r.closeID, r.closeDialogID = id, dialogID
			r.mu.Unlock()
			return ipc.PamCloseDialogResult{Closed: true, WasOpen: true}, nil
		},
		pamDismissConsent: func(_ *sessionbroker.Session, id string, _ time.Duration) (ipc.PamDismissConsentResult, error) {
			r.add("dismiss_untargeted")
			r.mu.Lock()
			r.dismissID = id
			r.mu.Unlock()
			return ipc.PamDismissConsentResult{Success: true, Reason: "ok"}, nil
		},
		pamDismissConsentInstance: func(_ *sessionbroker.Session, id string, inst ipc.PamConsentInstance, _ time.Duration) (ipc.PamDismissConsentResult, error) {
			r.add("dismiss_targeted")
			r.mu.Lock()
			r.instanceID, r.instance = id, inst
			r.mu.Unlock()
			return ipc.PamDismissConsentResult{Success: true, Reason: "ok"}, nil
		},
	}
	return h, r
}

func pendingEvent(sessionID uint32, consent etwlua.ConsentInstance) etwlua.Event {
	return etwlua.Event{
		SubjectUsername:      `CORP\user`,
		SubjectSessionID:     sessionID,
		TargetExecutablePath: `C:\Tools\app.exe`,
		Consent:              consent,
	}
}

func TestRunPamFlowDialogTimeoutClosesDialogBeforeDismissing(t *testing.T) {
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2", SupportsPamDialogClose: true}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{}, sessionbroker.ErrCommandTimeout)

	// No consent.exe identity: the untargeted dismissal is the only option,
	// so the dialog MUST be gone before its Escape.
	h.RunPamFlow(context.Background(), pendingEvent(2, etwlua.ConsentInstance{}),
		etwlua.ElevationOutcome{RequestID: "req-1", Status: etwlua.ElevationPending})

	if want := []string{"dialog", "close_dialog", "dismiss_untargeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
	if r.closeDialogID != "req-1" {
		t.Errorf("close targeted dialog %q, want the dialog's own envelope id req-1", r.closeDialogID)
	}
	if r.closeID == "req-1" || r.closeID == "" {
		t.Errorf("close command id = %q; it must not reuse the dialog's envelope id", r.closeID)
	}
	// A late pam_dialog_result for req-1 must not be routable to the
	// dismissal's waiter.
	if r.dismissID == "req-1" || r.dismissID == "" {
		t.Errorf("dismiss id = %q; it must not reuse the dialog's envelope id", r.dismissID)
	}
}

func TestRunPamFlowDialogErrorTargetsTheRequestsOwnConsent(t *testing.T) {
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2",
		SupportsPamDialogClose: true, SupportsTargetedPamDismiss: true}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{}, sessionbroker.ErrCommandTimeout)

	h.RunPamFlow(context.Background(), pendingEvent(2, testConsent),
		etwlua.ElevationOutcome{RequestID: "req-2", Status: etwlua.ElevationPending})

	if want := []string{"dialog", "close_dialog", "dismiss_targeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
	want := ipc.PamConsentInstance{PID: testConsent.PID, CreatedUnixNano: testConsent.CreatedAt.UnixNano()}
	if r.instance != want {
		t.Errorf("targeted instance = %+v, want %+v", r.instance, want)
	}
	if r.instanceID == "req-2" || r.instanceID == "" {
		t.Errorf("targeted dismiss id = %q; it must not reuse the dialog's envelope id", r.instanceID)
	}
}

func TestRunPamFlowUserDenyDoesNotSendCloseDialog(t *testing.T) {
	// The user answered: the helper's window is already gone.
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2", SupportsPamDialogClose: true}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{Approved: false, DismissedByUser: true}, nil)

	h.RunPamFlow(context.Background(), pendingEvent(2, etwlua.ConsentInstance{}),
		etwlua.ElevationOutcome{RequestID: "req-3", Status: etwlua.ElevationPending})

	if want := []string{"dialog", "dismiss_untargeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
}

func TestRunPamFlowDialogTimeoutSkipsCloseForOlderHelper(t *testing.T) {
	// An older helper never advertised pam_close_dialog: it is not sent.
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2"}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{}, sessionbroker.ErrCommandTimeout)

	h.RunPamFlow(context.Background(), pendingEvent(2, etwlua.ConsentInstance{}),
		etwlua.ElevationOutcome{RequestID: "req-4", Status: etwlua.ElevationPending})

	if want := []string{"dialog", "dismiss_untargeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
}

func TestRunPamFlowDialogTimeoutCloseFailureStillDenies(t *testing.T) {
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2", SupportsPamDialogClose: true}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{}, sessionbroker.ErrCommandTimeout)
	h.pamCloseDialog = func(*sessionbroker.Session, string, string, time.Duration) (ipc.PamCloseDialogResult, error) {
		r.add("close_dialog")
		return ipc.PamCloseDialogResult{}, sessionbroker.ErrCommandTimeout
	}

	h.RunPamFlow(context.Background(), pendingEvent(2, etwlua.ConsentInstance{}),
		etwlua.ElevationOutcome{RequestID: "req-5", Status: etwlua.ElevationPending})

	if want := []string{"dialog", "close_dialog", "dismiss_untargeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
}

func TestRunPamFlowAnyDialogErrorClosesDialogFirst(t *testing.T) {
	// Not only a timeout: a helper error or a garbled result leaves the
	// dialog's state unknown, so it is taken down too.
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2", SupportsPamDialogClose: true}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{}, errors.New("decode PAM dialog result: unexpected EOF"))

	h.RunPamFlow(context.Background(), pendingEvent(2, etwlua.ConsentInstance{}),
		etwlua.ElevationOutcome{RequestID: "req-10", Status: etwlua.ElevationPending})

	if want := []string{"dialog", "close_dialog", "dismiss_untargeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
}

func TestRunPamFlowDialogStillOpenStillDenies(t *testing.T) {
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2", SupportsPamDialogClose: true}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{}, sessionbroker.ErrCommandTimeout)
	h.pamCloseDialog = func(*sessionbroker.Session, string, string, time.Duration) (ipc.PamCloseDialogResult, error) {
		r.add("close_dialog")
		return ipc.PamCloseDialogResult{Closed: false, WasOpen: true, Reason: "dialog_still_open"}, nil
	}

	h.RunPamFlow(context.Background(), pendingEvent(2, etwlua.ConsentInstance{}),
		etwlua.ElevationOutcome{RequestID: "req-11", Status: etwlua.ElevationPending})

	if want := []string{"dialog", "close_dialog", "dismiss_untargeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
}

func TestDenyConsentTargetedFallsBackOnlyWhenHelperCannotTarget(t *testing.T) {
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2", SupportsTargetedPamDismiss: true}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{}, nil)
	h.pamDismissConsentInstance = func(*sessionbroker.Session, string, ipc.PamConsentInstance, time.Duration) (ipc.PamDismissConsentResult, error) {
		r.add("dismiss_targeted")
		return ipc.PamDismissConsentResult{}, sessionbroker.ErrPamTargetedDismissUnsupported
	}

	h.denyConsent(session, "req-6", "policy_denied", "2", testConsent)

	if want := []string{"dismiss_targeted", "dismiss_untargeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
}

func TestDenyConsentTargetedFailureDoesNotPressAnUntargetedEscape(t *testing.T) {
	// consent_not_foreground means an Escape would reach some other window
	// (the very bug in #10370): never fall back to the untargeted press.
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2", SupportsTargetedPamDismiss: true}
	h, r := newDenyRig(t, session, ipc.PamDialogResult{}, nil)
	h.pamDismissConsentInstance = func(*sessionbroker.Session, string, ipc.PamConsentInstance, time.Duration) (ipc.PamDismissConsentResult, error) {
		r.add("dismiss_targeted")
		return ipc.PamDismissConsentResult{Success: false, Reason: "consent_not_foreground"}, nil
	}

	h.denyConsent(session, "req-7", "policy_denied", "2", testConsent)

	if want := []string{"dismiss_targeted"}; !reflect.DeepEqual(r.got(), want) {
		t.Fatalf("deny sequence = %v, want %v", r.got(), want)
	}
}

func TestDenyConsentUntargetedWhenTargetingIsUnsafe(t *testing.T) {
	cases := []struct {
		name             string
		session          *sessionbroker.Session
		targetWinSession string
		consent          etwlua.ConsentInstance
	}{
		{"no consent identity", &sessionbroker.Session{WinSessionID: "2", SupportsTargetedPamDismiss: true}, "2", etwlua.ConsentInstance{}},
		{"requester session unresolved", &sessionbroker.Session{WinSessionID: "1", SupportsTargetedPamDismiss: true}, "", testConsent},
		{"helper in another session", &sessionbroker.Session{WinSessionID: "3", SupportsTargetedPamDismiss: true}, "2", testConsent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, r := newDenyRig(t, tc.session, ipc.PamDialogResult{}, nil)
			h.denyConsent(tc.session, "req-8", "policy_denied", tc.targetWinSession, tc.consent)
			if want := []string{"dismiss_untargeted"}; !reflect.DeepEqual(r.got(), want) {
				t.Fatalf("deny sequence = %v, want %v", r.got(), want)
			}
		})
	}
}

func TestDenyConsentTargetedUncertainEngagesGate(t *testing.T) {
	session := &sessionbroker.Session{SessionID: "helper", WinSessionID: "2", SupportsTargetedPamDismiss: true}
	h, _ := newDenyRig(t, session, ipc.PamDialogResult{}, nil)
	quiesced := make(chan sessionbroker.PamDismissOutcome, 1)
	h.pamDismissConsentInstance = func(*sessionbroker.Session, string, ipc.PamConsentInstance, time.Duration) (ipc.PamDismissConsentResult, error) {
		return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{Cause: errors.New("timed out"), Quiesced: quiesced}
	}
	h.stopChan = make(chan struct{})
	defer close(h.stopChan)

	h.denyConsent(session, "req-9", "policy_denied", "2", testConsent)

	h.pamActuateMu.Lock()
	engaged := h.pamDismissalUncertain
	h.pamActuateMu.Unlock()
	if !engaged {
		t.Fatal("an unproven targeted deny must engage the fail-closed PAM gate like the untargeted one")
	}
	quiesced <- sessionbroker.PamDismissOutcome{Proven: true, Result: ipc.PamDismissConsentResult{Success: true, Reason: "ok"}}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h.pamActuateMu.Lock()
		engaged = h.pamDismissalUncertain
		h.pamActuateMu.Unlock()
		if !engaged {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("gate not released after the helper proved the targeted dismissal")
}
