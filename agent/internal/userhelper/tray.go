package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

// TrayManager is the interface for platform-specific system tray icon management.
type TrayManager interface {
	Update(update ipc.TrayUpdate) error
	OnAction(callback func(menuItemID string))
	Close() error
}

// updateTray updates the system tray icon/menu. Platform-specific.
func updateTray(update ipc.TrayUpdate) {
	updateTrayOS(update)
}
