//go:build windows

package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

// updateTrayOS updates the system tray on Windows.
// A production implementation would use Shell_NotifyIcon.
func updateTrayOS(update ipc.TrayUpdate) {
	log.Debug("tray update", "status", update.Status, "tooltip", update.Tooltip, "items", len(update.MenuItems))
}
