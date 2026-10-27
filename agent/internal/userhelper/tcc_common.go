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
	// remindPermissions lets the loop show its own Full Disk Access
	// guidance (the first-run dialog, then reminder toasts). False only when
	// the agent said it shows the permission notice itself (#10190 W04).
	remindPermissions bool
}

// tccLoopPolicyFor gates the loop's prompts on the binary kind.
// RunTCCCheckLoop starts in every userhelper.Client.Run, including
// `breeze-agent user-helper` (the legacy com.breeze.agent-user LaunchAgent).
// Only the desktop helper captures the screen or injects input, and the
// broker drops a TCC status from any session without the desktop scope, so
// for every other kind a prompt would ask the user for something nothing
// uses.
//
// agentHandlesNotice is this connection's AuthResponse.AgentHandlesTCCNotice
// (see ShowsOwnTCCReminder): when set, the agent shows the permission notice
// from this helper's tcc_status and the helper must not show its own too.
func tccLoopPolicyFor(binaryKind string, agentHandlesNotice bool) tccLoopPolicy {
	p := tccLoopPolicy{remindPermissions: !agentHandlesNotice}
	if binaryKind == ipc.HelperBinaryDesktopHelper {
		p.requestScreenRecording, p.promptAccessibility, p.reportRemoteDesktop = true, true, true
	}
	return p
}

// ShowsOwnTCCReminder reports whether a helper shows its own macOS
// permission reminder on a connection whose authentication returned resp
// (#10190 W04 skew rule). An older agent omits the flag, so a new helper
// keeps reminding; an older helper never reads it and always reminds, and
// the agent never sets it for a helper whose live advertisement lacks
// notice.info@1.
func ShowsOwnTCCReminder(resp ipc.AuthResponse) bool {
	return !resp.AgentHandlesTCCNotice
}
