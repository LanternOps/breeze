//go:build darwin

package userhelper

import (
	"os/exec"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showNotificationOS uses osascript to display notifications on macOS.
// A production implementation would use UNUserNotificationCenter via cgo/ObjC.
func showNotificationOS(req ipc.NotifyRequest) bool {
	script := `display notification "` + escapeAppleScript(req.Body) + `" with title "` + escapeAppleScript(req.Title) + `"`
	cmd := exec.Command("osascript", "-e", script)
	if err := cmd.Run(); err != nil {
		log.Warn("notification failed", "error", err)
		return false
	}
	return true
}

// escapeAppleScript escapes a string for safe embedding in an AppleScript
// double-quoted string. Handles quotes, backslashes, and control characters
// that could break out of the string context.
func escapeAppleScript(s string) string {
	result := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case ch == '"':
			result = append(result, '\\', '"')
		case ch == '\\':
			result = append(result, '\\', '\\')
		case ch == '\n':
			result = append(result, '\\', 'n')
		case ch == '\r':
			result = append(result, '\\', 'r')
		case ch == '\t':
			result = append(result, '\\', 't')
		case ch < 0x20 || ch == 0x7f:
			// Strip other control characters
			continue
		default:
			result = append(result, ch)
		}
	}
	return string(result)
}
