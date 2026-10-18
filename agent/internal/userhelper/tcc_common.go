package userhelper

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func systemSettingsURLForPermission(permission string) (string, error) {
	switch permission {
	case "Screen Recording":
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", nil
	case "Accessibility":
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", nil
	case "Full Disk Access":
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", nil
	default:
		return "", fmt.Errorf("unknown permission %q", permission)
	}
}

// tccLoopPolicy is what a helper's TCC check loop may do (#8058).
type tccLoopPolicy struct {
	// requestScreenRecording lets the loop raise the macOS Screen Recording
	// consent dialog (rate-limited by maybeRequestScreenRecording).
	requestScreenRecording bool
	// promptAccessibility lets the loop raise the Accessibility prompt once.
	promptAccessibility bool
	// reportRemoteDesktop lets the loop fill TCCStatus.RemoteDesktop from the
	// non-capturing access check (desktop.CheckCaptureAccess, #8390). No
	// permission check captures the screen any more.
	reportRemoteDesktop bool
}

// tccLoopPolicyFor gates the loop's prompts on the binary kind.
// RunTCCCheckLoop starts in every userhelper.Client.Run, including
// `breeze-agent user-helper` (the legacy com.breeze.agent-user LaunchAgent).
// Only the desktop helper captures the screen or injects input, and the
// broker drops a TCC status from any session without the desktop scope, so
// for every other kind a prompt would ask the user for something nothing
// uses.
func tccLoopPolicyFor(binaryKind string) tccLoopPolicy {
	if binaryKind == ipc.HelperBinaryDesktopHelper {
		return tccLoopPolicy{requestScreenRecording: true, promptAccessibility: true, reportRemoteDesktop: true}
	}
	return tccLoopPolicy{}
}
