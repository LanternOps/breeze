//go:build linux

package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

// updateTrayOS updates the system tray on Linux.
// A production implementation would use StatusNotifierItem D-Bus or libappindicator.
func updateTrayOS(update ipc.TrayUpdate) {
	log.Debug("tray update", "status", update.Status, "tooltip", update.Tooltip, "items", len(update.MenuItems))
}
