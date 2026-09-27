package userhelper

import (
	"sync"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Notifier is the interface for platform-specific desktop notification delivery.
type Notifier interface {
	Show(req ipc.NotifyRequest) bool
	Close() error
}

// showNotificationFn is the platform toast seam, mirroring showConsentDialogFn
// and showNotifyPromptFn. Tests swap it so the notify handler's routing can be
// asserted without shelling out to PowerShell/osascript/notify-send.
var showNotificationFn = showNotificationOS

// showNotification sends a desktop notification. Platform-specific.
// Returns true if the notification was delivered.
func showNotification(req ipc.NotifyRequest) bool {
	return showNotificationFn(req)
}

// showNoticeDialogFn is the platform seam for the notice fallback dialog: an
// informational, OK-only, self-dismissing dialog shown when a toast that the
// user must see could not be shown (NotifyRequest.FallbackDialog, #6864). It
// reports whether the dialog rendered. Tests swap it.
var showNoticeDialogFn = showNoticeDialogOS

// noticeDialogMu serialises fallback dialogs inside one helper. The start and
// end notices of a short remote session can arrive while the first dialog is
// still open; the second waits (bounded by each platform's own
// noticeDialogTimeoutMs, declared alongside showNoticeDialogOS) instead of
// stacking a second topmost window on the first.
var noticeDialogMu sync.Mutex

// showNotificationWithFallback raises the toast and, when the request asks for
// it and the toast failed, the fallback dialog. It returns whether the user was
// shown anything.
func showNotificationWithFallback(req ipc.NotifyRequest) bool {
	if showNotification(req) {
		return true
	}
	if !req.FallbackDialog {
		return false
	}
	log.Info("toast unavailable; showing the notice as a dialog")
	noticeDialogMu.Lock()
	defer noticeDialogMu.Unlock()
	if !showNoticeDialogFn(req) {
		log.Warn("notice fallback dialog could not be shown; the user was not notified")
		return false
	}
	return true
}
