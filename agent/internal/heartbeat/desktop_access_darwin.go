//go:build darwin

package heartbeat

import (
	"os"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func (h *Heartbeat) computeDesktopAccess(_ *collectors.SystemInfo) *DesktopAccessState {
	now := time.Now().UTC()
	state := &DesktopAccessState{
		Mode:                "unavailable",
		LoginUIReachable:    false,
		VirtualDisplayReady: false,
		CheckedAt:           now,
	}

	desktopSession := h.sessionBroker.PreferredDesktopSession()
	tccStatus := h.sessionBroker.TCCStatus()
	if desktopSession != nil {
		if desktopTCC := desktopSession.GetTCCStatus(); desktopTCC != nil {
			cp := *desktopTCC
			tccStatus = &cp
		}
	}

	if tccStatus != nil {
		state.RemoteDesktopPermission = tccStatus.RemoteDesktop
		if !tccStatus.ScreenRecording || !tccStatus.Accessibility {
			state.Reason = "missing_permission"
		}
	}

	if desktopSession != nil {
		switch {
		case tccStatus == nil:
			if state.Reason == "" {
				state.Reason = "helper_not_connected"
			}
		case !tccStatus.ScreenRecording || !tccStatus.Accessibility:
			state.Reason = "missing_permission"
		case tccStatus.RemoteDesktop == nil:
			if desktopSession.DesktopContext == ipc.DesktopContextLoginWindow {
				state.Reason = "virtual_display_unavailable"
			} else if state.Reason == "" {
				state.Reason = "helper_not_connected"
			}
		case !*tccStatus.RemoteDesktop:
			state.Reason = "missing_permission"
		default:
			switch desktopSession.DesktopContext {
			case ipc.DesktopContextLoginWindow:
				// Apple blocks synthetic input at the login window on all macOS
				// versions for third-party agents without a private entitlement,
				// so WebRTC desktop can never drive the login screen. Report
				// unsupported_os so the UI falls back to VNC Relay, which uses
				// native macOS Screen Sharing via `kickstart` and doesn't need
				// the synthetic-input path.
				state.Reason = "unsupported_os"
			case ipc.DesktopContextUserSession, "":
				state.Mode = "user_session"
				return state
			}
		}

		switch desktopSession.DesktopContext {
		case ipc.DesktopContextLoginWindow:
			if state.Reason == "" {
				state.Reason = "virtual_display_unavailable"
			}
		case ipc.DesktopContextUserSession, "":
			if state.Reason == "" {
				state.Reason = "helper_not_connected"
			}
		}
	}

	if _, err := os.Stat("/usr/local/bin/breeze-desktop-helper"); err != nil {
		if state.Reason == "" {
			state.Reason = "manual_install"
		}
		return state
	}

	if state.Reason == "" {
		state.Reason = "helper_not_connected"
	}
	return state
}
