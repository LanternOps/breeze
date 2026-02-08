package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

// Notifier is the interface for platform-specific desktop notification delivery.
type Notifier interface {
	Show(req ipc.NotifyRequest) bool
	Close() error
}

// showNotification sends a desktop notification. Platform-specific.
// Returns true if the notification was delivered.
func showNotification(req ipc.NotifyRequest) bool {
	return showNotificationOS(req)
}
