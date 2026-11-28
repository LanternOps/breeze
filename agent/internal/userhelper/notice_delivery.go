package userhelper

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Native notice delivery (#10190 W04, plan Task 4.1; spec §3.2 "Focus
// rules").
//
// On Windows the native user-helper delivers a notice.info by the session's
// notification state (SHQueryUserNotificationState, notify_state_windows.go):
//
//   - QUNS_ACCEPTS_NOTIFICATIONS: a toast;
//   - QUNS_QUIET_TIME, QUNS_NOT_PRESENT: the native dialog, because the
//     toast would be suppressed while the API still reports success, and
//     the toast as well, so the notice stays in the notification centre
//     after the dialog closes (spec §2: "toast + FallbackDialog");
//   - QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE: hold,
//     re-polling every 30 s until the list entry expires, then toast or
//     dialog as above. The agent is told prompt_presented{visible:false}
//     so it does not fall back to the legacy toast after its present budget;
//     the notice is in the agent's list meanwhile.
//
// macOS and Linux have no equivalent query (spec §3.2): there the notice is
// the OS notification, as it is with the prompt kinds off (#12794; spec §2
// "Native fallback matrix": display notification / notify-send). Only when
// that notification cannot be shown does it become a dialog — or when the notice
// offers an action a notification cannot carry (the permission notice's
// Open Settings), as the legacy first-run permission dialog did.
//
// A notice drawn as a dialog, on any OS, lives at most
// nativeNoticeDialogLifetime (or until its own deadline, if sooner), never
// stacks on another notice and does not open over a question that needs an
// answer, except from its last useful minute (its deadline less that
// lifetime): then it is drawn even over a question, and a later question
// opens over it without taking it down (prompt_native.go draw,
// noticeKeptUp). A notice the agent's card limiter made list-only
// (prompt_show rateLimited) is one notification and never a dialog, unless it
// is already in its last useful minute (deliverRateLimitedNotice). A held
// notice that then waits for the screen tells the agent visible:false once
// (reportNotVisible). A notice's deadline is otherwise its list
// lifetime, made for Assist's list (24 h), and never a dialog's. Untagged
// so every CI run checks it; the Windows file only makes the call.

type noticeDelivery int

const (
	noticeToast noticeDelivery = iota + 1
	noticeDialog
	noticeHold
)

func (d noticeDelivery) String() string {
	switch d {
	case noticeToast:
		return "toast"
	case noticeDialog:
		return "dialog"
	case noticeHold:
		return "hold"
	}
	return "unknown"
}

// QUERY_USER_NOTIFICATION_STATE (shellapi.h).
const (
	qunsNotPresent           uint32 = 1
	qunsBusy                 uint32 = 2
	qunsRunningD3DFullScreen uint32 = 3
	qunsPresentationMode     uint32 = 4
	qunsAcceptsNotifications uint32 = 5
	qunsQuietTime            uint32 = 6
	qunsApp                  uint32 = 7
	defaultNoticeRepoll             = 30 * time.Second
	defaultNoticeHoldTTL            = 7 * 24 * time.Hour // the list-entry lifetime
	noticeKind                      = "notice.info"
)

// noticeDeliveryFor maps a notification state to how a notice is delivered.
//
// An unknown state or a failed query delivers the dialog. A dialog is drawn
// whenever Windows lets a window be drawn, so it is the choice that cannot
// leave the notice unseen: holding on an error could hold it until it
// expires, and a toast could be silently swallowed by quiet hours. The
// notice is in the agent's list either way.
//
// QUNS_APP (Windows 8: an immersive Store app in front) is not one of the
// spec's hold states and toasts are shown over Store apps, so it toasts.
func noticeDeliveryFor(state uint32, err error) noticeDelivery {
	if err != nil {
		return noticeDialog
	}
	switch state {
	case qunsAcceptsNotifications, qunsApp:
		return noticeToast
	case qunsBusy, qunsRunningD3DFullScreen, qunsPresentationMode:
		return noticeHold
	case qunsQuietTime, qunsNotPresent:
		return noticeDialog
	}
	return noticeDialog
}

// queryNoticeState asks the notification state, warning once per failure
// streak (a held notice re-polls every 30 s).
func (r *nativePromptRenderer) queryNoticeState() (uint32, error) {
	state, err := r.noticeState()
	r.mu.Lock()
	defer r.mu.Unlock()
	if err == nil {
		r.noticeStateFailing = false
		return state, nil
	}
	if !r.noticeStateFailing {
		r.noticeStateFailing = true
		r.noticeStateWarnings++
		log.Warn("cannot read the Windows notification state; notices are shown as dialogs until it can be read", "error", err.Error())
	}
	return state, err
}

// noticeHasActions reports whether a notice offers anything beyond its
// acknowledgement (the safe OK), such as the permission notice's Open
// Settings.
func noticeHasActions(p ipc.PromptShow) bool {
	for _, a := range p.Actions {
		if a.Role != ipc.PromptRoleSafe {
			return true
		}
	}
	return false
}

// noticeDeliveryNow is how a notice is delivered right now: by the
// notification state where the platform has the query (Windows), else as a
// notification (macOS, Linux).
func (r *nativePromptRenderer) noticeDeliveryNow() noticeDelivery {
	if r.noticeState == nil {
		return noticeToast
	}
	return noticeDeliveryFor(r.queryNoticeState())
}

// deliverNotice runs the toast / hold half of a notice's delivery. It
// returns true when it finished the notice (toasted, or the hold ended
// because the agent withdrew it or its entry expired) and false when the
// caller must draw the dialog.
func (r *nativePromptRenderer) deliverNotice(ctx context.Context, p ipc.PromptShow, m nativePromptModel, act *nativeActive, lease func() ipc.PromptLease) bool {
	repoll := r.noticeRepoll
	if repoll <= 0 {
		repoll = defaultNoticeRepoll
	}
	// The hold ends at the notice's own end: its deadline (a safe-mode
	// warning means nothing after the reboot) or its list expiry, whichever
	// comes first. Both are absolute, so a replay never restarts them.
	expires := r.now().Add(defaultNoticeHoldTTL)
	for _, ms := range []int64{p.ListEntry.ExpiresAtUnixMs, p.Timing.DeadlineUnixMs} {
		if at := time.UnixMilli(ms); ms > 0 && at.Before(expires) {
			expires = at
		}
	}
	toldHeld := false
	for {
		d := r.noticeDeliveryNow()
		if d == noticeDialog && r.noticeState != nil {
			// Windows quiet hours, nobody present, or a state that could not
			// be read: the dialog may close before the person is back, so
			// the toast is raised as well and the notice stays in the
			// notification centre (spec §2: "toast + FallbackDialog"). The
			// dialog reports the notice presented, not the toast.
			if !r.toast(ipc.NotifyRequest{Title: m.Title, Body: m.Body}) {
				log.Info("notice toast not shown alongside its dialog", "promptId", p.PromptID)
			}
			return false
		}
		if d == noticeToast && noticeHasActions(p) {
			// A notification has no buttons, so an action beyond OK (macOS
			// Open Settings) would be lost: draw the short-lived dialog, as
			// the legacy first-run permission dialog did.
			d = noticeDialog
		}
		switch d {
		case noticeToast:
			if r.toast(ipc.NotifyRequest{Title: m.Title, Body: m.Body}) {
				r.reply(ipc.TypePromptPresented, ipc.PromptPresented{PromptID: p.PromptID, Rev: p.Rev, Lease: lease(), Visible: true})
				return true
			}
			log.Info("notice toast not shown; drawing it as a dialog", "promptId", p.PromptID)
			return false
		case noticeDialog:
			return false
		}
		if !toldHeld {
			toldHeld = true
			log.Info("holding a notice while the user is presenting or full screen", "promptId", p.PromptID)
			r.reportNotVisible(p, act)
		}
		if !r.now().Before(expires) {
			log.Info("held notice expired before it could be shown; it stays in the agent's list", "promptId", p.PromptID)
			return true
		}
		t := time.NewTimer(repoll)
		select {
		case <-ctx.Done():
			t.Stop()
			return true
		case <-t.C:
		}
		if ctx.Err() != nil {
			return true
		}
	}
}

// claimNoticeDialog lets a notice become a dialog only when no other dialog
// is on screen (screenBusyLocked). force skips that check: the notice's last
// useful moment has come (awaitNoticeDialog). current is false when the
// notice was closed or replaced meanwhile.
func (r *nativePromptRenderer) claimNoticeDialog(promptID string, act *nativeActive, force bool) (claimed, current bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active[promptID] != act {
		return false, false
	}
	if !force && r.screenBusyLocked(promptID) {
		return false, true
	}
	act.noticeDialog = true
	return true, true
}

// screenBusyLocked reports whether a dialog other than promptID's is on
// screen that a notice dialog must not open over: a question that needs an
// answer (any active prompt that is neither a notice nor a session pill), a
// pill's "End session?" confirm, or another notice dialog. Caller holds mu.
func (r *nativePromptRenderer) screenBusyLocked(promptID string) bool {
	for id, a := range r.active {
		if id == promptID {
			continue
		}
		if a.indicator != nil {
			if a.indicator.confirmRev != 0 {
				return true
			}
			continue
		}
		if a.noticeDialog || !isNoticeShow(a.show) {
			return true
		}
	}
	return false
}

// awaitNoticeDialog claims the screen for a notice that must be a dialog,
// waiting while another dialog is up: a notice that cannot be shown now is
// deferred, never dropped (#12794 review). While it waits the agent is told
// prompt_presented{visible:false}, once per notice and not again if a hold
// already said so (reportNotVisible), so it neither counts the notice as
// seen nor falls back after its present budget; the legacy notice dialog
// waited the same way. A notice with a deadline (the safe-mode reboot
// warning: the reboot) does not wait past its last useful moment, the
// deadline less the notice dialog's lifetime: it is drawn then even over
// another dialog, because an unwarned reboot is worse than two windows, and
// from then on a later decision opens over it without taking it down
// (noticeKeptUp). It reports false when the agent closed or replaced the notice meanwhile.
func (r *nativePromptRenderer) awaitNoticeDialog(ctx context.Context, p ipc.PromptShow, act *nativeActive, lease func() ipc.PromptLease) bool {
	mustShowBy, forces := noticeMustShowBy(p)
	told := false // logged once; the agent is told once per notice (reportNotVisible)
	for {
		freed := r.freedSignal()
		force := forces && !r.now().Before(mustShowBy)
		claimed, current := r.claimNoticeDialog(p.PromptID, act, force)
		if !current || ctx.Err() != nil {
			return false
		}
		if claimed {
			if told {
				log.Info("waiting notice drawn", "promptId", p.PromptID, "overAnotherDialog", force)
			}
			return true
		}
		if !told {
			told = true
			log.Info("notice waits: another dialog is on screen; it is drawn when that dialog ends", "promptId", p.PromptID)
			r.reportNotVisible(p, act)
		}
		if !r.waitForScreen(ctx, freed, mustShowBy, forces) {
			return false
		}
	}
}

// reportNotVisible tells the agent prompt_presented{visible:false} for a
// notice that is not on screen yet, once per active notice (one nativeActive;
// a redraw by an update starts a new one). A Windows notice
// held while the person is full screen that then has to wait for another
// dialog is one notice not yet visible, not two (#12812): the hold and the
// wait each used to say so.
func (r *nativePromptRenderer) reportNotVisible(p ipc.PromptShow, act *nativeActive) {
	r.mu.Lock()
	if act.toldNotVisible {
		r.mu.Unlock()
		return
	}
	act.toldNotVisible = true
	lease := act.show.Lease // a replay may have moved it
	r.mu.Unlock()
	r.reply(ipc.TypePromptPresented, ipc.PromptPresented{PromptID: p.PromptID, Rev: p.Rev, Lease: lease, Visible: false})
}

// waitForScreen waits until a dialog leaves the screen (freed), the
// notice's last useful moment (when forces), or the agent closes the notice
// (false).
func (r *nativePromptRenderer) waitForScreen(ctx context.Context, freed <-chan struct{}, mustShowBy time.Time, forces bool) bool {
	var due <-chan time.Time
	if forces {
		t := time.NewTimer(max(mustShowBy.Sub(r.now()), 0))
		defer t.Stop()
		due = t.C
	}
	select {
	case <-ctx.Done():
		return false
	case <-freed:
	case <-due:
	}
	return true
}

// noticeMustShowBy is the last moment a notice dialog can open and still be
// up for its full lifetime before the notice ends (its deadline or its list
// expiry, whichever comes first). ok is false for a notice with neither.
func noticeMustShowBy(p ipc.PromptShow) (at time.Time, ok bool) {
	var end time.Time
	for _, ms := range []int64{p.Timing.DeadlineUnixMs, p.ListEntry.ExpiresAtUnixMs} {
		if t := time.UnixMilli(ms); ms > 0 && (end.IsZero() || t.Before(end)) {
			end = t
		}
	}
	if end.IsZero() {
		return time.Time{}, false
	}
	return end.Add(-nativeNoticeDialogLifetime), true
}

// announceUpdate raises an OS notification for an update to a decision
// whose dialog already ended (#12794 review): after Postpone the agent
// re-plans the answered prompt with the new time and the native path redraws
// nothing, so the new content is announced as the legacy lead rung was, as a
// notification and never a dialog. A notice, a terminal outcome and a list
// entry announce nothing. failed runs when an announcement was due but no
// notification was shown (onUpdate then forgets it, so a repeat tries again).
func (r *nativePromptRenderer) announceUpdate(p ipc.PromptShow, failed func()) {
	if isNoticeShow(p) || p.Presentation == ipc.PromptPresentationListOnly || !ipc.IsPromptDecision(p.State, p.Presentation) {
		return
	}
	m, err := buildNativePromptModel(p, r.now(), nil)
	if err != nil {
		log.Warn("updated prompt not announced", "promptId", p.PromptID, "error", err.Error())
		failed()
		return
	}
	req := ipc.NotifyRequest{Title: m.Title, Body: m.Body}
	r.goAsync(func() {
		if !r.toast(req) {
			log.Warn("updated prompt not announced: the notification was not shown; the next update with this text tries again", "promptId", p.PromptID)
			failed()
		}
	})
}

// forgetTold undoes onUpdate's record of an announcement that was not shown,
// unless a later announcement replaced it meanwhile. Takes mu.
func (r *nativePromptRenderer) forgetTold(promptID, next, last string, hadLast bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.told[promptID] != next {
		return
	}
	if hadLast {
		r.told[promptID] = last
	} else {
		delete(r.told, promptID)
	}
}

// announcementText is what an announcement of p says, before the renderer
// fills its placeholders: the title and every part of the body. The deadline
// is part of it, because {remaining} is counted from it. A rev bump alone (an
// empty patch) or a repeat of the same refresh gives the same text.
func announcementText(p ipc.PromptShow) string {
	parts := []string{p.Copy.Title, p.Copy.Body, p.Copy.Consequence, p.Copy.StateDetail, p.Copy.OperatorNote,
		strconv.FormatInt(p.Timing.DeadlineUnixMs, 10)}
	if p.Timing.Expiry != nil {
		parts = append(parts, p.Timing.Expiry.Text)
	}
	for _, f := range p.Facts {
		parts = append(parts, f.Label, f.Value)
	}
	return strings.Join(parts, "\x00")
}

// deliverRateLimitedNotice delivers a notice the agent's card limiter made
// list-only (prompt_show rateLimited, #12828). A renderer with a list lists
// it; this one has none, so list-only alone would show it nowhere, which is
// worse than the prompt kinds off (each notice a notification). It is
// delivered in this renderer's quietest form: one OS notification, never a
// window, so a flood of notices never becomes a wall of dialogs. The
// notification state decides only the visible flag: the agent is told
// prompt_presented, visible only when the notification was shown and the
// session accepts notifications now (Windows quiet hours, nobody present or
// full screen silence it). A notification the OS refuses is not retried. A
// notice inside its last useful minute never gets here (draw keeps its own
// rules). The notice is remembered as ended, so a later update is recorded;
// a repeat of the same or an older rev raises nothing.
func (r *nativePromptRenderer) deliverRateLimitedNotice(p ipc.PromptShow) {
	m, err := buildNativePromptModel(p, r.now(), nil)
	if err != nil {
		log.Warn("native renderer refused a rate-limited notice", "promptId", p.PromptID, "error", err.Error())
		r.takeDown(p.PromptID)
		r.renderFailed(p, "invalid_prompt")
		return
	}
	r.takeDown(p.PromptID)
	r.mu.Lock()
	prev, known := r.ended[p.PromptID]
	repeat := known && prev.Rev >= p.Rev
	if !repeat {
		r.rememberEndedLocked(p)
	}
	r.mu.Unlock()
	if repeat {
		return // delivered already: one notification per notice
	}
	req := ipc.NotifyRequest{Title: m.Title, Body: m.Body}
	r.goAsync(func() {
		seeable := r.noticeState == nil || r.noticeDeliveryNow() == noticeToast
		shown := r.toast(req)
		if !shown {
			log.Warn("rate-limited notice: the notification was not shown; it stays in the agent's list only", "promptId", p.PromptID)
		}
		r.reply(ipc.TypePromptPresented, ipc.PromptPresented{PromptID: p.PromptID, Rev: p.Rev, Lease: p.Lease, Visible: shown && seeable})
	})
}
