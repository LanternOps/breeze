package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamdecline"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// elevation.request@1 through RunPamFlow and a real prompt host (#10190
// W07, plan Task 7.2).

const elevReq = "7e1e0000-0000-4000-8000-000000010221"

var elevOwner = prompthost.Owner{WinSessionID: 3, UserSID: "S-1-5-21-3003"}

type elevRig struct {
	t      *testing.T
	h      *Heartbeat
	host   *prompthost.Host
	dir    *rcDir
	clock  *rcClock
	store  *pamdecline.Store
	kicks  chan struct{}
	secure bool

	mu            sync.Mutex
	legacyDialogs int
	denies        []string
	dismissedInst []string
	dismissOK     bool
	toasts        []string
	consentGone   bool
	done          chan struct{}
}

func elevAssist(key string) prompthost.RendererSession {
	return prompthost.RendererSession{Key: key, Role: ipc.HelperRoleAssist, Owner: elevOwner, Protocol: 1, KindAds: []string{"elevation.request@1"}, ConnectedAt: time.Now()}
}

func elevSystem(key string) prompthost.RendererSession {
	return prompthost.RendererSession{Key: key, Role: ipc.HelperRoleSystem, Owner: elevOwner, Protocol: 1, KindAds: []string{"elevation.request@1"}, ConnectedAt: time.Now()}
}

func newElevRig(t *testing.T, secure bool, enabled []string, renderers ...prompthost.RendererSession) *elevRig {
	t.Helper()
	r := &elevRig{t: t, secure: secure, dismissOK: true, kicks: make(chan struct{}, 8), done: make(chan struct{})}
	r.dir = &rcDir{rs: renderers}
	r.clock = &rcClock{t: time.Now()}
	r.host = prompthost.New(prompthost.Deps{Broker: r.dir, Inbox: &rcInbox{m: map[string]prompthost.ListEntry{}}, Clock: r.clock})
	promptkinds.Register(r.host)
	r.host.SetEnabledKinds(enabled)
	r.store = pamdecline.NewStore("", nil)
	helper := &sessionbroker.Session{SessionID: "pam-helper", WinSessionID: "3"}
	r.h = &Heartbeat{
		promptHost:      r.host,
		pamDeclines:     r.store,
		pamWithdrawKick: r.kicks,
		pamFindSession:  func(string, string) *sessionbroker.Session { return helper },
		pamRequestDialog: func(*sessionbroker.Session, string, ipc.PamRequestDialog, time.Duration) (ipc.PamDialogResult, error) {
			r.mu.Lock()
			r.legacyDialogs++
			r.mu.Unlock()
			return ipc.PamDialogResult{Approved: true}, nil
		},
		pamDismissConsent: func(_ *sessionbroker.Session, id string, _ time.Duration) (ipc.PamDismissConsentResult, error) {
			r.mu.Lock()
			r.denies = append(r.denies, id)
			r.mu.Unlock()
			return ipc.PamDismissConsentResult{Success: true}, nil
		},
		pamDismissConsentInstance: func(_ *sessionbroker.Session, id string, _ ipc.PamConsentInstance, _ time.Duration) (ipc.PamDismissConsentResult, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.dismissedInst = append(r.dismissedInst, id)
			if r.dismissOK {
				return ipc.PamDismissConsentResult{Success: true}, nil
			}
			return ipc.PamDismissConsentResult{Success: false, Reason: "consent_did_not_close"}, nil
		},
		pamNotifySink: func(title, body, ws string) error {
			r.mu.Lock()
			r.toasts = append(r.toasts, title)
			r.mu.Unlock()
			return nil
		},
		pamReportUnable:      func(string, pamUnable) {},
		pamSecureDesktop:     func() (bool, error) { return r.secure, nil },
		pamElevationOwner:    func(string) (prompthost.Owner, bool) { return elevOwner, true },
		elevationConsentPoll: 10 * time.Millisecond,
		pamConsentExited: func(etwlua.ConsentInstance) (bool, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			return r.consentGone, nil
		},
	}
	return r
}

func (r *elevRig) start() {
	go func() {
		defer close(r.done)
		r.h.RunPamFlow(context.Background(), etwlua.Event{
			TargetExecutablePath:   `C:\Program Files\7-Zip\7zFM.exe`,
			TargetExecutableSigner: "Igor Pavlov",
			SubjectSessionID:       3,
			Consent:                etwlua.ConsentInstance{PID: 4242, CreatedAt: time.Unix(1_800_000_000, 0)},
		}, etwlua.ElevationOutcome{RequestID: elevReq, Status: etwlua.ElevationPending, SupportName: "Northwind IT", PendingExpiresAt: time.Now().Add(15 * time.Minute)})
	}()
}

func (r *elevRig) wait() {
	r.t.Helper()
	select {
	case <-r.done:
	case <-time.After(10 * time.Second):
		r.t.Fatal("RunPamFlow did not return")
	}
}

// waitShow waits for a prompt_show to key and returns it.
func (r *elevRig) waitShow(key string) ipc.PromptShow {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var pending []rcSent
	for time.Now().Before(deadline) {
		pending = append(pending, r.dir.take()...)
		if s := rcShows(pending, key); len(s) > 0 {
			r.requeue(pending)
			return s[len(s)-1]
		}
		time.Sleep(5 * time.Millisecond)
	}
	r.t.Fatalf("no prompt_show to %s (got %+v)", key, pending)
	return ipc.PromptShow{}
}

// requeue puts messages back so later assertions still see them.
func (r *elevRig) requeue(msgs []rcSent) {
	r.dir.mu.Lock()
	r.dir.sent = append(msgs, r.dir.sent...)
	r.dir.mu.Unlock()
}

func (r *elevRig) act(key string, s ipc.PromptShow, action string) ipc.PromptActionResult {
	r.t.Helper()
	raw, _ := json.Marshal(ipc.PromptActionRequest{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, ActionID: action, Via: ipc.PromptViaClick})
	_, reply := r.host.HandleRendererMessage(&sessionbroker.Session{SessionID: key}, ipc.TypePromptAction, raw)
	return reply.(ipc.PromptActionResult)
}

func (r *elevRig) present(key string, s ipc.PromptShow) {
	raw, _ := json.Marshal(ipc.PromptPresented{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, Visible: true})
	r.host.HandleRendererMessage(&sessionbroker.Session{SessionID: key}, ipc.TypePromptPresented, raw)
}

// sendRequest drives the first question to the waiting card on Assist.
func (r *elevRig) sendRequest(firstKey string) (first, waiting ipc.PromptShow) {
	r.t.Helper()
	r.start()
	first = r.waitShow(firstKey)
	r.dir.take()
	if res := r.act(firstKey, first, promptkinds.ActionSendRequest); res.Result != ipc.PromptActionAccepted {
		r.t.Fatalf("send_request = %s", res.Result)
	}
	r.wait()
	return first, r.waitShow("assist-1")
}

var elevEnabled = []string{"elevation.request"}

func TestElevationLegacyWhenDisabled(t *testing.T) {
	r := newElevRig(t, true, nil, elevAssist("assist-1"), elevSystem("system-1"))
	r.start()
	r.wait()
	if r.legacyDialogs != 1 {
		t.Fatalf("legacy dialogs = %d, want today's call when the kind is not enabled", r.legacyDialogs)
	}
	if n := len(r.dir.take()); n != 0 {
		t.Fatalf("%d prompt messages sent with the kind disabled", n)
	}
}

func TestElevationLegacyWhenTheSystemHelperIsOldOnTheSecureDesktop(t *testing.T) {
	old := elevSystem("system-old")
	old.Protocol, old.KindAds = 0, nil // an old helper that survived the update
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), old)
	r.start()
	r.wait()
	if r.legacyDialogs != 1 || len(rcShows(r.dir.take(), "assist-1")) != 0 {
		t.Fatal("with the secure desktop on, only a SYSTEM helper that advertised the kind may ask; else today's dialog")
	}
}

func TestFirstQuestionRendererBySecureDesktopSetting(t *testing.T) {
	for _, tc := range []struct {
		secure bool
		key    string
	}{{true, "system-1"}, {false, "assist-1"}} {
		r := newElevRig(t, tc.secure, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
		r.start()
		s := r.waitShow(tc.key)
		if s.State != ipc.PromptStatePending || s.DefaultActionID != promptkinds.ActionCancel {
			t.Fatalf("secure=%v: first question %+v", tc.secure, s)
		}
		other := "assist-1"
		if tc.key == other {
			other = "system-1"
		}
		if n := len(rcShows(r.dir.take(), other)); n != 0 {
			t.Fatalf("secure=%v: %s also drew the first question", tc.secure, other)
		}
		r.act(tc.key, s, promptkinds.ActionCancel)
		r.wait()
		if r.legacyDialogs != 0 {
			t.Fatal("the legacy dialog was also shown")
		}
	}
}

func TestSendRequestMovesToAssistWithLeaseBump(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	first, waiting := r.sendRequest("system-1")
	msgs := r.dir.take()
	if c := rcCloses(msgs, "system-1"); len(c) != 1 || c[0].Reason != ipc.PromptCloseFenced {
		t.Fatalf("SYSTEM closes = %+v, want one fenced", c)
	}
	if waiting.State != ipc.PromptStateWaiting || waiting.Presentation != ipc.PromptPresentationCard {
		t.Fatalf("waiting = %s/%s", waiting.State, waiting.Presentation)
	}
	if waiting.Lease.RendererSession != "assist-1" || waiting.Rev <= first.Rev {
		t.Fatalf("lease %+v rev %d", waiting.Lease, waiting.Rev)
	}
	if len(r.dismissedInst) != 1 || !strings.HasSuffix(r.dismissedInst[0], "-sent-consent") {
		t.Fatalf("UAC prompt dismissals = %v, want the request's own prompt dismissed once after Send request", r.dismissedInst)
	}
	if refuse, _ := r.store.Check(elevReq); refuse {
		t.Fatal("Send request must leave the request applicable (consented)")
	}
	if _, ok := r.h.pamTracker().Get(elevReq); !ok {
		t.Fatal("the hand-off is tracked for the outcome notices")
	}
	if !strings.Contains(waiting.Copy.StateDetail, "{time:") {
		t.Fatalf("a proven dismissal shows the deadline: %q", waiting.Copy.StateDetail)
	}
}

func TestUnprovenDismissCopyAndGateClear(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	r.dismissOK = false
	_, waiting := r.sendRequest("system-1")
	if !strings.Contains(waiting.Copy.StateDetail, "You can close the Windows prompt") {
		t.Fatalf("unproven dismissal detail = %q", waiting.Copy.StateDetail)
	}
	r.h.pamActuateMu.Lock()
	gate := r.h.pamDismissalUncertain
	r.h.pamActuateMu.Unlock()
	if gate {
		t.Fatal("an unproven dismissal must never engage the fail-closed gate")
	}
	if _, ok := r.h.pamPendingConsents.peek(elevReq); !ok {
		t.Fatal("an unproven dismissal keeps the recorded prompt for the approved launch to retry")
	}
}

func TestDecisionDuringFirstQuestionSupersedes(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	r.start()
	r.waitShow("system-1")
	r.dir.take()
	reason := "Not on this device"
	res := handlePamRequestNotify(r.h, Command{ID: "c1", Payload: map[string]any{"requestId": elevReq, "outcome": "denied", "reason": reason}})
	r.wait()
	msgs := r.dir.take()
	if c := rcCloses(msgs, "system-1"); len(c) != 1 {
		t.Fatalf("the open first question was not taken down: %+v", c)
	}
	shows := rcShows(msgs, "assist-1")
	if len(shows) != 1 || shows[0].State != ipc.PromptStateDenied {
		t.Fatalf("Assist outcome = %+v", shows)
	}
	if body := pamNotifyResultBody(t, res); body["shown"] != true || body["renderer"] != elevationRendererAssist {
		t.Fatalf("notify result = %+v", body)
	}
	if refuse, code := r.store.Check(elevReq); !refuse || code != pamdecline.CodeUserDeclined {
		t.Fatalf("a superseded request stays refused locally: %v %s", refuse, code)
	}
	// #10370: the deny targets the request's own UAC prompt (its consent.exe
	// is known), never the untargeted Escape.
	if len(r.denies) != 0 || len(r.dismissedInst) != 1 || r.dismissedInst[0] != elevReq+pamDenyDismissIDSuffix {
		t.Fatalf("the UAC prompt of a denied request is dismissed by target: untargeted=%v targeted=%v", r.denies, r.dismissedInst)
	}
	if len(r.toasts) != 0 {
		t.Fatalf("Assist showed the outcome; no toast too: %v", r.toasts)
	}
}

func TestApprovedVerifiedActiveAndFailed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result pamlifetime.Result
		want   ipc.PromptState
		body   string
	}{
		{"verified active", pamlifetime.Result{State: pamlifetime.ResultVerifiedActive}, ipc.PromptStateApproved, "Dana at Northwind IT approved 7zFM.exe"},
		{"failed", pamlifetime.Result{State: pamlifetime.ResultFailed, FailureCode: "launch_failed"}, ipc.PromptStateFailed, "couldn't start"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
			r.sendRequest("system-1")
			r.dir.take()
			r.h.notifyPamApplyOutcome(elevReq, tc.result, "Dana")
			shows := rcShows(r.dir.take(), "assist-1")
			if len(shows) != 1 || shows[0].State != tc.want || !strings.Contains(shows[0].Copy.Body, tc.body) {
				t.Fatalf("outcome = %+v", shows)
			}
			if len(r.toasts) != 0 {
				t.Fatalf("toast shown as well: %v", r.toasts)
			}
		})
	}
}

func TestUserDecisionFailureShowsNoOutcome(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	r.sendRequest("system-1")
	r.dir.take()
	r.h.notifyPamApplyOutcome(elevReq, pamlifetime.Result{State: pamlifetime.ResultFailed, FailureCode: "user_declined"}, "")
	if n := len(r.dir.take()); n != 0 {
		t.Fatalf("a user-decision refusal changed the card (%d messages)", n)
	}
}

func TestOutcomeFallsBackToTheNoticeWithoutAssist(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevSystem("system-1"))
	r.start()
	first := r.waitShow("system-1")
	r.act("system-1", first, promptkinds.ActionSendRequest)
	r.wait()
	r.h.notifyPamApplyOutcome(elevReq, pamlifetime.Result{State: pamlifetime.ResultVerifiedActive}, "")
	if len(r.toasts) != 1 || r.toasts[0] != "Request approved" {
		t.Fatalf("with no Assist the #8928 notice is shown: %v", r.toasts)
	}
}

func TestCancelRequestWithdrawsUserCancelledAndRecordsDecline(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	_, waiting := r.sendRequest("system-1")
	r.dir.take()
	if res := r.act("assist-1", waiting, promptkinds.ActionCancelRequest); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("cancel_request = %s", res.Result)
	}
	if refuse, code := r.store.Check(elevReq); !refuse || code != pamdecline.CodeUserDeclined {
		t.Fatalf("a cancelled request must be refused locally: %v %s", refuse, code)
	}
	due := r.store.Due()
	if len(due) != 1 || due[0].ServerReason() != pamdecline.ReasonUserCancelled || due[0].ServerStatus != "pending" {
		t.Fatalf("withdraw due = %+v", due)
	}
	select {
	case <-r.kicks:
	default:
		t.Fatal("the withdraw drain was not kicked")
	}
	if got := r.h.pamWithdrawRenderer(elevReq); got != elevationRendererAssist {
		t.Fatalf("withdraw renderer = %q", got)
	}
	if _, ok := r.h.pamTracker().Get(elevReq); ok {
		t.Fatal("a cancelled request must not toast an outcome later")
	}
	// A later server outcome changes nothing on screen.
	if r.h.elevationOutcome(elevReq, ipc.PromptStateApproved, "", "") {
		t.Fatal("an outcome after Cancel request was shown")
	}
}

func TestHideDoesNotCancel(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	_, waiting := r.sendRequest("system-1")
	if res := r.act("assist-1", waiting, promptkinds.ActionHide); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("hide = %s", res.Result)
	}
	if refuse, _ := r.store.Check(elevReq); refuse {
		t.Fatal("hide declined the request")
	}
	if r.h.pamElevations.get(elevReq) == nil {
		t.Fatal("hide ended the flow")
	}
}

func TestNoNativeRedrawAfterUserSwitch(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevSystem("system-1"))
	r.start()
	first := r.waitShow("system-1")
	r.present("system-1", first)
	r.dir.take()
	// Fast user switching: the requester's SYSTEM helper goes away and a new
	// one connects in the same session.
	r.dir.mu.Lock()
	r.dir.rs = nil
	r.dir.mu.Unlock()
	r.host.RendererDisconnected("system-1")
	next := elevSystem("system-2")
	r.dir.mu.Lock()
	r.dir.rs = []prompthost.RendererSession{next}
	r.dir.mu.Unlock()
	r.host.RendererConnected(next)
	r.host.Tick()
	r.wait()
	if n := len(rcShows(r.dir.take(), "system-2")); n != 0 {
		t.Fatalf("the first question was redrawn natively (%d shows)", n)
	}
	if refuse, code := r.store.Check(elevReq); !refuse || code != pamdecline.CodeUserDeclined {
		t.Fatalf("a lost first question is declined: %v %s", refuse, code)
	}
	if r.legacyDialogs != 0 {
		t.Fatal("a lost first question must not be re-asked with today's dialog either")
	}
}

func TestUACPromptClosingSupersedesTheFirstQuestion(t *testing.T) {
	r := newElevRig(t, false, elevEnabled, elevAssist("assist-1"))
	r.start()
	r.waitShow("assist-1")
	r.dir.take()
	r.mu.Lock()
	r.consentGone = true
	r.mu.Unlock()
	r.wait()
	if c := rcCloses(r.dir.take(), "assist-1"); len(c) != 1 || c[0].Reason != ipc.PromptCloseSuperseded {
		t.Fatalf("closes = %+v, want superseded", c)
	}
	due := r.store.Due()
	if len(due) != 1 || due[0].ServerReason() != pamdecline.ReasonUserCancelled {
		t.Fatalf("withdraw = %+v, want user_cancelled", due)
	}
}

func TestFirstQuestionExpiryDeclinesAsTimeout(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevSystem("system-1"))
	r.start()
	first := r.waitShow("system-1")
	r.present("system-1", first)
	r.clock.advance(time.Duration(promptkinds.ElevationFirstQuestionMs)*time.Millisecond + time.Second)
	r.host.Tick()
	r.wait()
	for _, e := range r.store.Snapshot() {
		if e.RequestID == elevReq && e.Reason == pamdecline.ReasonUserTimeout {
			return
		}
	}
	t.Fatalf("expiry not declined as user_timeout: %+v", r.store.Snapshot())
}

func TestSecureDesktopValue(t *testing.T) {
	for _, tc := range []struct {
		v    uint64
		err  error
		want bool
	}{{0, nil, false}, {1, nil, true}, {2, nil, true}, {0, errSecureDesktopValueMissing, true}, {0, errors.New("denied"), true}} {
		got, _ := secureDesktopFromValue(tc.v, tc.err)
		if got != tc.want {
			t.Fatalf("value %d err %v = %v, want %v", tc.v, tc.err, got, tc.want)
		}
	}
}

func TestPamApplyV2AcceptsDecidedBy(t *testing.T) {
	var cmd pamlifetime.ApplyCommand
	err := decodePamLifetimePayload(map[string]any{"requestId": elevReq, "decidedBy": map[string]any{"technicianName": "Dana"}}, &cmd)
	if err != nil || cmd.DecidedBy.Technician() != "Dana" {
		t.Fatalf("decidedBy = %+v, %v", cmd.DecidedBy, err)
	}
	if err := decodePamLifetimePayload(map[string]any{"requestId": elevReq, "decidedBy": map[string]any{"technicianName": nil}}, &cmd); err != nil || cmd.DecidedBy.Technician() != "" {
		t.Fatalf("null technician = %v", err)
	}
	if pamUserNotifyProtocolCurrent < 2 {
		t.Fatal("an agent that accepts decidedBy must report pamUserNotifyProtocolVersion >= 2")
	}
}
