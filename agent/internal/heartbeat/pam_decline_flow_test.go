package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/pamdecline"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #8971: RunPamFlow records the end user's answer in the durable decline
// store before it acts on it, so a later remote apply can refuse a declined
// request even if the server never hears about the decline.

const declineFlowReq = "5a1e0000-0000-4000-8000-000000008971"

type declineFlowRig struct {
	h             *Heartbeat
	store         *pamdecline.Store
	dialogCalls   int
	dismissCalls  int
	findCalls     int
	stateAtFind   string
	stateAtDialog string
	stateAtDismis string
	kicks         chan struct{}
}

// entryState describes the store's view of declineFlowReq: "absent",
// "awaiting", or "declined/<reason>".
func entryState(s *pamdecline.Store, id string) string {
	refuse, code := s.Check(id)
	if !refuse {
		return "absent"
	}
	if code == pamdecline.CodeUserDecisionPending {
		return "awaiting"
	}
	for _, e := range s.Snapshot() {
		if e.RequestID == id {
			return fmt.Sprintf("%s/%s", e.State, e.Reason)
		}
	}
	return code
}

func newDeclineFlowRig(t *testing.T, store *pamdecline.Store, dialog ipc.PamDialogResult, dialogErr error) *declineFlowRig {
	t.Helper()
	if store == nil {
		store = pamdecline.NewStore("", nil)
	}
	r := &declineFlowRig{store: store, kicks: make(chan struct{}, 4)}
	session := &sessionbroker.Session{SessionID: "pam-helper"}
	r.h = &Heartbeat{
		pamDeclines:     store,
		pamWithdrawKick: r.kicks,
		pamFindSession: func(string, string) *sessionbroker.Session {
			r.findCalls++
			r.stateAtFind = entryState(store, declineFlowReq)
			return session
		},
		pamRequestDialog: func(*sessionbroker.Session, string, ipc.PamRequestDialog, time.Duration) (ipc.PamDialogResult, error) {
			r.dialogCalls++
			r.stateAtDialog = entryState(store, declineFlowReq)
			return dialog, dialogErr
		},
		pamDismissConsent: func(*sessionbroker.Session, string, time.Duration) (ipc.PamDismissConsentResult, error) {
			r.dismissCalls++
			r.stateAtDismis = entryState(store, declineFlowReq)
			return ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"}, nil
		},
		pamReportUnable: func(string, pamUnable) {},
	}
	return r
}

func (r *declineFlowRig) run(status etwlua.ElevationStatus) {
	r.h.RunPamFlow(context.Background(), etwlua.Event{TargetExecutablePath: `C:\Temp\setup.exe`},
		etwlua.ElevationOutcome{RequestID: declineFlowReq, Status: status})
}

func (r *declineFlowRig) kicked() bool {
	select {
	case <-r.kicks:
		return true
	default:
		return false
	}
}

func TestRunPamFlowRecordsDecline(t *testing.T) {
	cases := []struct {
		name        string
		status      etwlua.ElevationStatus
		dialog      ipc.PamDialogResult
		dialogErr   error
		wantState   string
		wantDue     bool
		wantKick    bool
		wantDismiss bool
	}{
		{name: "pending + Deny", status: etwlua.ElevationPending,
			dialog: ipc.PamDialogResult{Approved: false, DismissedByUser: true}, wantState: "declined/user_denied",
			wantDue: true, wantKick: true, wantDismiss: true},
		{name: "pending + round-trip timeout", status: etwlua.ElevationPending,
			dialogErr: fmt.Errorf("wait: %w", sessionbroker.ErrCommandTimeout), wantState: "declined/user_timeout",
			wantDue: true, wantKick: true, wantDismiss: true},
		{name: "pending + other round-trip error", status: etwlua.ElevationPending,
			dialogErr: errors.New("helper went away"), wantState: "declined/dialog_error",
			wantDue: true, wantKick: true, wantDismiss: true},
		{name: "pending + helper countdown expiry", status: etwlua.ElevationPending,
			dialog: ipc.PamDialogResult{Approved: false, DismissedByUser: false}, wantState: "declined/user_timeout",
			wantDue: true, wantKick: true, wantDismiss: true},
		{name: "pending + Approve", status: etwlua.ElevationPending,
			dialog: ipc.PamDialogResult{Approved: true}, wantState: "absent"},
		{name: "auto_approved + Deny", status: etwlua.ElevationAutoApproved,
			dialog: ipc.PamDialogResult{Approved: false, DismissedByUser: true}, wantState: "declined/user_denied",
			wantDue: false, wantKick: true, wantDismiss: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newDeclineFlowRig(t, nil, tc.dialog, tc.dialogErr)
			r.run(tc.status)

			if r.stateAtFind != "awaiting" {
				t.Errorf("state at session lookup = %q, want awaiting (recorded before the lookup)", r.stateAtFind)
			}
			if r.stateAtDialog != "awaiting" {
				t.Errorf("state when the dialog was shown = %q, want awaiting", r.stateAtDialog)
			}
			if got := entryState(r.store, declineFlowReq); got != tc.wantState {
				t.Errorf("final state = %q, want %q", got, tc.wantState)
			}
			if tc.wantDismiss {
				if r.dismissCalls != 1 {
					t.Fatalf("dismiss calls = %d, want 1", r.dismissCalls)
				}
				// Recorded BEFORE consent.exe is dismissed (which can take up
				// to pamDismissTimeout): an approval landing mid-dismiss must
				// already be refused.
				if r.stateAtDismis != tc.wantState {
					t.Errorf("state at dismiss = %q, want %q", r.stateAtDismis, tc.wantState)
				}
			} else if r.dismissCalls != 0 {
				t.Errorf("dismiss calls = %d, want 0", r.dismissCalls)
			}
			if due := len(r.store.Due()) == 1; due != tc.wantDue {
				t.Errorf("due for delivery = %v, want %v", due, tc.wantDue)
			}
			if k := r.kicked(); k != tc.wantKick {
				t.Errorf("withdraw drain kicked = %v, want %v", k, tc.wantKick)
			}
		})
	}
}

func TestRunPamFlowAutoApprovedApproveRemovesEntry(t *testing.T) {
	manager := &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	var stateAtTrigger string
	r := newDeclineFlowRig(t, nil, ipc.PamDialogResult{Approved: true}, nil)
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{
			trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
				stateAtTrigger = entryState(r.store, declineFlowReq)
				return pamactuator.Result{Success: true, Reason: "actuated"}
			},
			dismiss: func(context.Context) pamactuator.Result { return pamactuator.Result{Success: true} },
		}
	})

	r.run(etwlua.ElevationAutoApproved)

	if stateAtTrigger != "absent" {
		t.Errorf("state at local actuation = %q, want absent (consent recorded first)", stateAtTrigger)
	}
	if got := entryState(r.store, declineFlowReq); got != "absent" {
		t.Errorf("final state = %q, want absent", got)
	}
}

func TestRunPamFlowPolicyDeniedRecordsNothing(t *testing.T) {
	r := newDeclineFlowRig(t, nil, ipc.PamDialogResult{}, nil)
	r.run(etwlua.ElevationDenied)

	if r.dialogCalls != 0 {
		t.Errorf("dialog calls = %d, want 0", r.dialogCalls)
	}
	if r.dismissCalls != 1 {
		t.Errorf("dismiss calls = %d, want 1 (policy hard-deny)", r.dismissCalls)
	}
	if r.store.Len() != 0 {
		t.Errorf("store has %d entries, want 0", r.store.Len())
	}
}

func TestRunPamFlowNoHelperSessionReleasesEntry(t *testing.T) {
	r := newDeclineFlowRig(t, nil, ipc.PamDialogResult{}, nil)
	r.h.pamFindSession = func(string, string) *sessionbroker.Session {
		r.stateAtFind = entryState(r.store, declineFlowReq)
		return nil
	}

	r.run(etwlua.ElevationPending)

	if r.stateAtFind != "awaiting" {
		t.Errorf("state at session lookup = %q, want awaiting", r.stateAtFind)
	}
	if r.dialogCalls != 0 {
		t.Fatalf("dialog calls = %d, want 0", r.dialogCalls)
	}
	// No dialog was shown: today's behaviour for that request is kept.
	if got := entryState(r.store, declineFlowReq); got != "absent" {
		t.Errorf("final state = %q, want absent (released)", got)
	}
}

func TestRunPamFlowNoBrokerReleasesEntry(t *testing.T) {
	store := pamdecline.NewStore("", nil)
	h := &Heartbeat{pamDeclines: store}

	h.RunPamFlow(context.Background(), etwlua.Event{}, etwlua.ElevationOutcome{RequestID: declineFlowReq, Status: etwlua.ElevationPending})

	if got := entryState(store, declineFlowReq); got != "absent" {
		t.Errorf("final state = %q, want absent (released)", got)
	}
}

func TestRunPamFlowAlreadyDeclinedSkipsDialog(t *testing.T) {
	r := newDeclineFlowRig(t, nil, ipc.PamDialogResult{Approved: true}, nil)
	if err := r.store.Decline(declineFlowReq, pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}

	// A re-fired UAC event for a request the user already declined.
	r.run(etwlua.ElevationPending)

	if r.dialogCalls != 0 {
		t.Errorf("dialog calls = %d, want 0: a declined request is never offered again", r.dialogCalls)
	}
	if r.dismissCalls != 1 {
		t.Errorf("dismiss calls = %d, want 1", r.dismissCalls)
	}
	if got := entryState(r.store, declineFlowReq); got != "declined/user_denied" {
		t.Errorf("final state = %q, want declined/user_denied", got)
	}
}

func TestRunPamFlowDialogPanicDeclinesAsDialogError(t *testing.T) {
	r := newDeclineFlowRig(t, nil, ipc.PamDialogResult{}, nil)
	r.h.pamRequestDialog = func(*sessionbroker.Session, string, ipc.PamRequestDialog, time.Duration) (ipc.PamDialogResult, error) {
		panic("simulated dialog seam panic")
	}

	r.run(etwlua.ElevationPending)

	if got := entryState(r.store, declineFlowReq); got != "declined/dialog_error" {
		t.Errorf("final state = %q, want declined/dialog_error", got)
	}
	if !r.kicked() {
		t.Error("withdraw drain not kicked after the recovered panic")
	}
}

func TestRunPamFlowPersistFailureStillDismisses(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permission bits do not block writes on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permission bits")
	}
	dir := filepath.Join(t.TempDir(), "ro")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	store := pamdecline.NewStore(filepath.Join(dir, "pam-declined-requests.json"), nil)
	r := newDeclineFlowRig(t, store, ipc.PamDialogResult{Approved: false, DismissedByUser: true}, nil)

	r.run(etwlua.ElevationPending)

	if r.dismissCalls != 1 {
		t.Fatalf("dismiss calls = %d, want 1: a persist failure must not block the deny", r.dismissCalls)
	}
	if got := entryState(store, declineFlowReq); got != "declined/user_denied" {
		t.Errorf("final state = %q, want declined/user_denied (kept in memory)", got)
	}
}

func TestPamWithdrawReasonTable(t *testing.T) {
	cases := []struct {
		name   string
		dialog ipc.PamDialogResult
		err    error
		want   pamdecline.Reason
	}{
		{"user clicked Deny", ipc.PamDialogResult{Approved: false, DismissedByUser: true}, nil, pamdecline.ReasonUserDenied},
		{"helper countdown expired", ipc.PamDialogResult{Approved: false, DismissedByUser: false}, nil, pamdecline.ReasonUserTimeout},
		{"approved but dismissed", ipc.PamDialogResult{Approved: true, DismissedByUser: true}, nil, pamdecline.ReasonUserDenied},
		{"round-trip timeout", ipc.PamDialogResult{Approved: false, DismissedByUser: true}, sessionbroker.ErrCommandTimeout, pamdecline.ReasonUserTimeout},
		{"wrapped round-trip timeout", ipc.PamDialogResult{}, fmt.Errorf("x: %w", sessionbroker.ErrCommandTimeout), pamdecline.ReasonUserTimeout},
		{"other round-trip error", ipc.PamDialogResult{Approved: false, DismissedByUser: true}, errors.New("decode failed"), pamdecline.ReasonDialogError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pamWithdrawReason(tc.dialog, tc.err); got != tc.want {
				t.Errorf("pamWithdrawReason = %q, want %q", got, tc.want)
			}
		})
	}
}

// Review fix (#10420): finish() logs a persist failure of the unanswered
// decision's decline at Error, like every other decline writer.
func TestFinishLogsPersistFailureAtError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permission bits do not block writes on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permission bits")
	}
	buf := capturePamLog(t)
	dir := filepath.Join(t.TempDir(), "ro")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	store := pamdecline.NewStore(filepath.Join(dir, pamDeclineFileName), nil)
	if err := store.Load(); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{pamDeclines: store}

	d, _ := h.beginPamDecision(declineFlowReq, "pending")
	d.finish()

	if got := entryState(store, declineFlowReq); got != "declined/dialog_error" {
		t.Fatalf("entry = %s, want declined/dialog_error held in memory", got)
	}
	if got := logLines(buf, "level=ERROR", declineFlowReq, "unanswered"); len(got) != 1 {
		t.Fatalf("want one Error line for the unpersisted decline, got %q\nlog:\n%s", got, buf.String())
	}
}
