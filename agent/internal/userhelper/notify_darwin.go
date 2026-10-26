//go:build darwin

package userhelper

import (
	"os/exec"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showNotificationOS uses osascript to display notifications on macOS.
// A production implementation would use UNUserNotificationCenter via cgo/ObjC.
func showNotificationOS(req ipc.NotifyRequest) bool {
	req = sanitizeNotifyRequest(req)
	script := `display notification "` + escapeAppleScript(req.Body) + `" with title "` + escapeAppleScript(req.Title) + `"`
	cmd := exec.Command("osascript", "-e", script)
	if err := cmd.Run(); err != nil {
		log.Warn("notification failed", "error", err)
		return false
	}
	return true
}
