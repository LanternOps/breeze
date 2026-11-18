package userhelper

import (
	"context"
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
//     toast would be suppressed while the API still reports success;
//   - QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE: hold,
//     re-polling every 30 s until the list entry expires, then toast or
//     dialog as above. The agent is told prompt_presented{visible:false}
//     so it does not fall back to the legacy toast after its present budget;
//     the notice is in the agent's list meanwhile.
//
// macOS and Linux have no equivalent query (spec §3.2): there the notice is
// the native dialog, as every other prompt. Untagged so every CI run checks
// it; the Windows file only makes the call.

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

// usesNotificationState reports whether a prompt is delivered by the
// notification state (a notice, on a platform that has the query).
func (r *nativePromptRenderer) usesNotificationState(p ipc.PromptShow) bool {
	return r.noticeState != nil && p.Kind == noticeKind
}

// deliverNotice runs the toast / hold half of a notice's delivery. It
// returns true when it finished the notice (toasted, or the hold ended
// because the agent withdrew it or its entry expired) and false when the
// caller must draw the dialog.
func (r *nativePromptRenderer) deliverNotice(ctx context.Context, p ipc.PromptShow, m nativePromptModel, lease func() ipc.PromptLease) bool {
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
		d := noticeDeliveryFor(r.queryNoticeState())
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
			r.reply(ipc.TypePromptPresented, ipc.PromptPresented{PromptID: p.PromptID, Rev: p.Rev, Lease: lease(), Visible: false})
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
