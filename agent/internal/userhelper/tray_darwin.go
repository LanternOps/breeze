//go:build darwin

package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

// updateTrayOS updates the system tray on macOS.
// A production implementation would use NSStatusItem via cgo/ObjC.
func updateTrayOS(update ipc.TrayUpdate) {
	log.Debug("tray update", "status", update.Status, "tooltip", update.Tooltip, "items", len(update.MenuItems))
}
