package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

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
