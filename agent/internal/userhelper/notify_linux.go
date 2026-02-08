//go:build linux

package userhelper

import (
	"os/exec"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showNotificationOS uses notify-send for desktop notifications on Linux.
// A production implementation would use D-Bus org.freedesktop.Notifications directly.
func showNotificationOS(req ipc.NotifyRequest) bool {
	args := []string{req.Title, req.Body}

	if req.Urgency != "" {
		args = append([]string{"-u", req.Urgency}, args...)
	}
	if req.Icon != "" {
		args = append([]string{"-i", req.Icon}, args...)
	}

	cmd := exec.Command("notify-send", args...)
	if err := cmd.Run(); err != nil {
		log.Warn("notification failed", "error", err)
		return false
	}
	return true
}
