//go:build darwin

package heartbeat

import (
	"os"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func (h *Heartbeat) computeDesktopAccess(sysInfo *collectors.SystemInfo) *DesktopAccessState {
	now := time.Now().UTC()
	state := &DesktopAccessState{
		Mode:                "unavailable",
		LoginUIReachable:    false,
		VirtualDisplayReady: false,
		CheckedAt:           now,
	}

	unsupportedOS := isUnsupportedDarwinVersion(sysInfo)

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
				if unsupportedOS {
					state.Reason = "unsupported_os"
				} else {
					state.Mode = "login_window"
					state.LoginUIReachable = true
					return state
				}
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

func isUnsupportedDarwinVersion(sysInfo *collectors.SystemInfo) bool {
	if sysInfo == nil {
		return false
	}

	version := strings.TrimSpace(strings.TrimPrefix(strings.ToLower(sysInfo.OSVersion), "darwin"))
	if version == "" {
		return false
	}

	major := strings.SplitN(version, ".", 2)[0]
	switch major {
	case "20", "21", "22":
		return true
	default:
		return false
	}
}
