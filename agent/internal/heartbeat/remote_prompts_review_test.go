package heartbeat

import (
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// #10351 review follow-ups (W06, #10190).

// stopRecorder replaces the user-end report and the stop routine.
type stopRecorder struct {
	mu      sync.Mutex
	order   []string
	reports int
	stops   int
}

func (r *stopRecorder) install(t *testing.T, reportErr error, stopResult tools.CommandResult) {
	t.Helper()
	prevSend, prevStop := desktopUserEndSender, desktopUserEndStop
	desktopUserEndSender = func(*Heartbeat, websocket.CommandResult) error {
		r.mu.Lock()
		r.order = append(r.order, "userend")
		r.reports++
		r.mu.Unlock()
		return reportErr
	}
	desktopUserEndStop = func(_ *Heartbeat, cmd Command) tools.CommandResult {
		r.mu.Lock()
		r.order = append(r.order, "stop:"+cmd.Type)
		r.stops++
		r.mu.Unlock()
		return stopResult
	}
	t.Cleanup(func() { desktopUserEndSender, desktopUserEndStop = prevSend, prevStop })
}

func (r *stopRecorder) counts() (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reports, r.stops
}

// endedPill drives a pill to end_confirm and returns the probe.
func endedPill(t *testing.T) (*Heartbeat, *helperProbe) {
	t.Helper()
	native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, []string{"remote.session@1"})
	h := noticeHeartbeat(t, []string{"remote.session"}, native)
	prompt := consentPrompt("block", 30_000)
	prompt.Mode, prompt.ShowIndicator, prompt.AllowUserEndSession = "notify", true, true
	rememberDesktopPrompt(remoteTestSession, prompt)
	t.Cleanup(func() { takeDesktopPrompt(remoteTestSession) })
	h.afterDesktopStart(remoteTestSession, prompt, "")
	s := firstShow(t, native)
	presentShow(t, h, native, s)
	res := actOn(t, h, native, s, s.Rev, "end_session")
	if res := actOn(t, h, native, s, res.Rev, "end_confirm"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("end_confirm = %+v", res)
	}
	return h, native
}

func closeReasons(t *testing.T, p *helperProbe) []ipc.PromptCloseReason {
	t.Helper()
	var out []ipc.PromptCloseReason
	for _, e := range envelopesOf(p, ipc.TypePromptClose) {
		var c ipc.PromptClose
		_ = json.Unmarshal(e.Payload, &c)
		out = append(out, c.Reason)
	}
	return out
}

// HIGH: a stop that fails (the capture helper did not answer) leaves the
// session running. The pill comes back with End session, says the session is
// still active, and the session is not ended.
func TestEndedByUserStopFailureReshowsThePill(t *testing.T) {
	rec := &stopRecorder{}
	rec.install(t, nil, tools.NewErrorResult(errors.New("IPC desktop_stop: timeout"), 10_000))
	h, native := endedPill(t)
	eventually(t, func() bool { return promptShows(native) == 2 }, "the re-shown pill")
	again := decodeShow(t, envelopesOf(native, ipc.TypePromptShow)[1])
	if again.PromptID != "session:"+remoteTestSession || again.Copy.StateDetail != "Couldn't end the session. It is still active." {
		t.Fatalf("re-shown pill = %s %+v", again.PromptID, again.Copy)
	}
	if _, ok := actionByIDShow(again, "end_session"); !ok {
		t.Fatalf("the person can try again: %+v", again.Actions)
	}
	if first := decodeShow(t, envelopesOf(native, ipc.TypePromptShow)[0]); again.Rev <= first.Rev {
		t.Fatalf("re-shown at rev %d", again.Rev)
	}
	if got := closeReasons(t, native); len(got) != 1 || got[0] != ipc.PromptCloseWithdrawn {
		t.Fatalf("closes = %v", got)
	}
	if !h.promptHost.IsOpen(again.PromptID) {
		t.Fatal("the re-shown pill is not open")
	}
	// Not ended: the session's prompt is still remembered (no end UX ran).
	desktopPromptsMu.Lock()
	_, remembered := desktopPrompts[remoteTestSession]
	desktopPromptsMu.Unlock()
	if !remembered {
		t.Fatal("a failed stop ran the session-end path")
	}
	if reports, stops := rec.counts(); reports != 1 || stops != 1 {
		t.Fatalf("reports %d stops %d", reports, stops)
	}
}

// The stop failed after the session had already ended (the peer dropped and
// the session-end path cleared it): no "still active" pill and no banner.
func TestFailedEndReshowSkippedWhenTheSessionAlreadyEnded(t *testing.T) {
	rec := &stopRecorder{}
	rec.install(t, nil, tools.NewErrorResult(errors.New("IPC desktop_stop: timeout"), 10_000))
	prev := desktopUserEndStop
	desktopUserEndStop = func(h *Heartbeat, cmd Command) tools.CommandResult {
		takeDesktopPrompt(remoteTestSession) // the session ended meanwhile
		return prev(h, cmd)
	}
	t.Cleanup(func() { desktopUserEndStop = prev })
	h, native := endedPill(t)
	eventually(t, func() bool { _, stops := rec.counts(); return stops == 1 }, "the stop")
	time.Sleep(300 * time.Millisecond)
	if n := promptShows(native); n != 1 {
		t.Fatalf("%d shows: an ended session got a re-shown pill", n)
	}
	assertNone(t, native, ipc.TypeBannerShow, "an ended session got a banner")
	if h.promptHost.IsOpen(promptkinds.RemoteSessionPromptID(remoteTestSession)) {
		t.Fatal("an orphan pill is open")
	}
}

// A session end that lands while the re-show is under way still closes it:
// the re-show and the session end are serialized per session.
func TestSessionEndDuringTheReshowStillClosesIt(t *testing.T) {
	native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, []string{"remote.session@1"})
	h := noticeHeartbeat(t, []string{"remote.session"}, native)
	prompt := consentPrompt("block", 30_000)
	prompt.Mode, prompt.ShowIndicator, prompt.AllowUserEndSession = "notify", true, true
	rememberDesktopPrompt(remoteTestSession, prompt)
	t.Cleanup(func() { takeDesktopPrompt(remoteTestSession) })
	ended := make(chan struct{})
	prevHook := indicatorReshowChecked
	indicatorReshowChecked = func() {
		// The session ends between the liveness check and the Show.
		go func() { h.handleConsentSessionEnd(remoteTestSession); close(ended) }()
		time.Sleep(100 * time.Millisecond)
	}
	t.Cleanup(func() { indicatorReshowChecked = prevHook })
	h.reshowIndicatorAfterFailedEnd(remoteTestSession, prompt, "", time.Now())
	<-ended
	if h.promptHost.IsOpen(promptkinds.RemoteSessionPromptID(remoteTestSession)) {
		t.Fatal("the session ended but its re-shown pill stayed up")
	}
	eventually(t, func() bool { return len(closeReasons(t, native)) >= 1 }, "the close to reach the renderer")
	if got := closeReasons(t, native); len(got) != 1 || got[0] != ipc.PromptCloseWithdrawn {
		t.Fatalf("closes = %v, want the re-shown pill withdrawn", got)
	}
}

// The stop can fail before end_confirm's close lands: the re-show waits for
// that close, so the close never takes down the re-shown pill.
func TestFailedEndReshowWaitsForTheEndConfirmClose(t *testing.T) {
	native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, []string{"remote.session@1"})
	h := noticeHeartbeat(t, []string{"remote.session"}, native)
	prompt := consentPrompt("block", 30_000)
	prompt.Mode, prompt.ShowIndicator, prompt.AllowUserEndSession = "notify", true, true
	t.Cleanup(func() { takeDesktopPrompt(remoteTestSession) })
	h.afterDesktopStart(remoteTestSession, prompt, "")
	firstShow(t, native)
	done := make(chan struct{})
	go func() {
		h.reshowIndicatorAfterFailedEnd(remoteTestSession, prompt, "", time.Now())
		close(done)
	}()
	time.Sleep(150 * time.Millisecond) // the close lands late
	h.closeSessionIndicator(remoteTestSession)
	<-done
	if !h.promptHost.IsOpen(promptkinds.RemoteSessionPromptID(remoteTestSession)) {
		t.Fatal("the late close took down the re-shown pill")
	}
}

// A stop that succeeds withdraws the pill exactly once and does not re-show it.
func TestEndedByUserStopSuccessWithdrawsThePillOnce(t *testing.T) {
	rec := &stopRecorder{}
	rec.install(t, nil, tools.NewSuccessResult(map[string]any{"stopped": true}, 1))
	_, native := endedPill(t)
	eventually(t, func() bool { _, stops := rec.counts(); return stops == 1 }, "the stop")
	time.Sleep(200 * time.Millisecond)
	if got := closeReasons(t, native); len(got) != 1 || got[0] != ipc.PromptCloseWithdrawn {
		t.Fatalf("closes = %v, want one withdrawn", got)
	}
	if n := promptShows(native); n != 1 {
		t.Fatalf("%d shows: a successful stop re-showed the pill", n)
	}
}

func actionByIDShow(s ipc.PromptShow, id string) (ipc.PromptAction, bool) {
	for _, a := range s.Actions {
		if a.ID == id {
			return a, true
		}
	}
	return ipc.PromptAction{}, false
}

// The user-end report failing does not stop the stop.
func TestEndDesktopSessionByUserStopsEvenIfTheReportFails(t *testing.T) {
	rec := &stopRecorder{}
	rec.install(t, errors.New("no websocket client"), tools.NewSuccessResult(map[string]any{"stopped": true}, 1))
	(&Heartbeat{}).endDesktopSessionByUser(remoteTestSession, nil)
	eventually(t, func() bool { _, stops := rec.counts(); return stops == 1 }, "the stop")
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.order) != 2 || rec.order[0] != "userend" || rec.order[1] != "stop:"+tools.CmdStopDesktop {
		t.Fatalf("order = %v", rec.order)
	}
}

// An invalid session id reports nothing and stops nothing.
func TestEndDesktopSessionByUserRefusesAnInvalidID(t *testing.T) {
	rec := &stopRecorder{}
	rec.install(t, nil, tools.NewSuccessResult(nil, 0))
	var failed atomic.Int32
	(&Heartbeat{}).endDesktopSessionByUser("../x", func() { failed.Add(1) })
	time.Sleep(150 * time.Millisecond)
	if reports, stops := rec.counts(); reports != 0 || stops != 0 || failed.Load() != 0 {
		t.Fatalf("reports %d stops %d failed %d", reports, stops, failed.Load())
	}
}

// Gap 1: the indicator's own fallbacks are exactly today's banner_show.
func TestSessionIndicatorRendererFailureFallsBackToBanner(t *testing.T) {
	for _, tc := range []string{"render_failed", "present budget", "show error"} {
		t.Run(tc, func(t *testing.T) {
			clock := &shiftClock{}
			native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, []string{"remote.session@1"})
			h := noticeHeartbeatAt(t, clock, []string{"remote.session"}, native)
			if tc == "show error" {
				prev := indicatorPromptShow
				indicatorPromptShow = func(*Heartbeat, prompthost.Prompt) error { return errors.New("refused") }
				t.Cleanup(func() { indicatorPromptShow = prev })
			}
			prompt := consentPrompt("block", 30_000)
			prompt.Mode, prompt.ShowIndicator = "notify", true
			t.Cleanup(func() { takeDesktopPrompt(remoteTestSession) })
			h.afterDesktopStart(remoteTestSession, prompt, "")
			switch tc {
			case "render_failed":
				s := firstShow(t, native)
				rendererSend(t, h, native, ipc.TypePromptClosed, ipc.PromptClosed{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, Reason: ipc.PromptClosedRenderFailed})
			case "present budget":
				firstShow(t, native)
				clock.advance(11 * time.Second)
				h.promptHost.Tick()
			}
			eventually(t, func() bool { return len(envelopesOf(native, ipc.TypeBannerShow)) >= 1 }, "the legacy banner")
			time.Sleep(100 * time.Millisecond)
			banners := envelopesOf(native, ipc.TypeBannerShow)
			var req ipc.BannerShowRequest
			_ = json.Unmarshal(banners[0].Payload, &req)
			if len(banners) != 1 || banners[0].ID != "banner-show-"+remoteTestSession || req.Label != "Dana Reyes from Northwind IT is connected" {
				t.Fatalf("banners = %d %s %+v", len(banners), banners[0].ID, req)
			}
		})
	}
}

// Gap 2a: a consent held behind another modal for the same user never
// reached a renderer: it is withdrawn and today's request goes out, once.
func TestConsentHeldBehindAModalTakesTheLegacyCallOnce(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	native := newNativeHelper(t)
	h := noticeHeartbeat(t, []string{"remote.consent"}, native)
	other := promptkinds.RemoteConsent(ipc.ConsentRequest{SessionID: "other", TimeoutMs: 60_000, Nonce: "ffffffffffffffffffffffffffffffff"}, *consentPrompt("block", 60_000), promptkinds.ConsentHooks{})
	other.Owners = []prompthost.Owner{noticeOwner(native.session)}
	if err := h.promptHost.Show(other); err != nil {
		t.Fatal(err)
	}
	att := waitAttempt(t, solicitAsync(h, consentPrompt("block", 1000)))
	reqs := envelopesOf(native, ipc.TypeConsentRequest)
	if len(reqs) != 1 {
		t.Fatalf("%d consent_requests, want exactly one", len(reqs))
	}
	var req ipc.ConsentRequest
	_ = json.Unmarshal(reqs[0].Payload, &req)
	if h.promptHost.IsOpen("consent:"+req.Nonce) || h.promptHost.Close("consent:"+req.Nonce, ipc.PromptCloseWithdrawn) != nil {
		t.Fatal("the held consent must be closed (withdrawn) in the host")
	}
	if att.outcome != ipc.ConsentOutcomeUnavailable || att.detail != "no_presentation" {
		t.Fatalf("attempt = %+v (today's v2 outcome for a silent helper)", att)
	}
	if promptShows(native) != 1 {
		t.Fatalf("%d shows: only the other consent was drawn", promptShows(native))
	}
}

// Gap 2b: the session ends after the consent was shown.
func TestConsentWithdrawnWhenTheSessionEndsAfterShow(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	native := newNativeHelper(t)
	h := noticeHeartbeat(t, []string{"remote.consent"}, native)
	ch := solicitAsync(h, consentPrompt("block", 30_000))
	s := firstShow(t, native)
	presentShow(t, h, native, s)
	withdrawConsentPrompt(remoteTestSession)
	att := waitAttempt(t, ch)
	if att.outcome != consentOutcomeUnknown || att.detail != consentDetailSessionEnded {
		t.Fatalf("attempt = %+v", att)
	}
	eventually(t, func() bool { return len(closeReasons(t, native)) == 1 }, "the close")
	if got := closeReasons(t, native); got[0] != ipc.PromptCloseWithdrawn {
		t.Fatalf("close = %v", got)
	}
	assertNone(t, native, ipc.TypeConsentRequest, "a withdrawn consent")
}

// Gap 3: the loss mapping, every reason × presented.
func TestConsentAttemptForLoss(t *testing.T) {
	for _, tc := range []struct {
		reason    string
		presented bool
		outcome   string
		detail    string
	}{
		{"renderer_gone", false, ipc.ConsentOutcomeUnavailable, "helper_disconnected"},
		{"renderer_gone", true, consentOutcomeUnknown, "helper_disconnected"},
		{"present_budget", false, ipc.ConsentOutcomeUnavailable, "no_presentation"},
		{"present_budget", true, consentOutcomeUnknown, "no_presentation"},
		{"send_failed", false, ipc.ConsentOutcomeUnavailable, "send_failed"},
		{"send_failed", true, consentOutcomeUnknown, "send_failed"},
		{"render_failed", false, ipc.ConsentOutcomeUnavailable, "render_failed"},
		{"render_failed", true, consentOutcomeUnknown, "failed_after_presentation"},
		{"something_new", false, ipc.ConsentOutcomeUnavailable, "renderer_lost"},
	} {
		got := consentAttemptForLoss(prompthost.PlacementInfo{Role: ipc.HelperRoleAssist, Presented: tc.presented}, tc.reason)
		if got.outcome != tc.outcome || got.detail != tc.detail || got.renderer != "assist" {
			t.Errorf("%s presented=%v = %+v, want %s/%s", tc.reason, tc.presented, got, tc.outcome, tc.detail)
		}
		if sanitizeConsentDetail(got.detail) != got.detail {
			t.Errorf("detail %q does not fit the API's consentDetail", got.detail)
		}
	}
}

// Gap 3: Assist killed BEFORE it confirmed the consent, under a proceed
// policy, with someone signed in: unavailable, refused, nothing re-asked.
func TestConsentAssistKilledBeforePresentationIsNotReasked(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	assist := newAssist(t, []string{"remote.consent@1"})
	native := newNativeHelper(t)
	h := noticeHeartbeat(t, []string{"remote.consent"}, assist, native)
	ch := solicitAsync(h, consentPrompt("proceed", 30_000))
	firstShow(t, assist)
	h.promptHost.PromptRendererDisconnected(assist.session)
	att := waitAttempt(t, ch)
	if att.outcome != ipc.ConsentOutcomeUnavailable || att.detail != "helper_disconnected" {
		t.Fatalf("attempt = %+v", att)
	}
	if v := decideConsent(att, "proceed", func() string { return occupancyOccupied }, func() bool { return true }); v.proceed {
		t.Fatalf("someone is signed in: an unshown consent must not proceed: %+v", v)
	}
	for i := 0; i < 3; i++ {
		h.promptHost.Tick()
	}
	assertNone(t, native, ipc.TypePromptShow, "re-asked on the native helper")
	assertNone(t, native, ipc.TypeConsentRequest, "re-asked through the legacy path")
}
