package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// #7047: on macOS, Apple drops synthetic keyboard and mouse input at the login
// window for agents without a private entitlement, and both injection calls
// still report success. A WebRTC session started there streams video that
// looks usable while every click and keystroke is silently discarded. The
// start must be refused, with a reason the viewer and web UI can show.

// withDesktopStartHostOS pins the OS the login-window gate believes it runs on,
// so the darwin-only branch is exercised on every CI platform.
func withDesktopStartHostOS(t *testing.T, goos string) {
	t.Helper()
	prev := desktopStartHostOS
	desktopStartHostOS = goos
	t.Cleanup(func() { desktopStartHostOS = prev })
}

// loginWindowTestHeartbeat returns a heartbeat whose broker reports consoleUser.
// No helper is connected, so a start that gets PAST the login-window gate with
// a consent "block" prompt ends at the consent gate as consent_denied — a
// distinct outcome the refusal assertions can tell apart.
func loginWindowTestHeartbeat(t *testing.T, consoleUser string) *Heartbeat {
	t.Helper()
	broker := newTestBrokerWithSessions(t)
	broker.SetConsoleUser(consoleUser)
	return &Heartbeat{
		sessionBroker: broker,
		desktopMgr:    desktop.NewSessionManager(),
	}
}

func assertLoginWindowRefusal(t *testing.T, result tools.CommandResult) {
	t.Helper()
	if result.Status != "failed" {
		t.Fatalf("start at the login window must fail, got status %q (stdout=%q)", result.Status, result.Stdout)
	}
	if !strings.Contains(result.Error, "("+DesktopStartRefusalLoginWindow+")") {
		t.Fatalf("refusal must carry the (%s) reason code, got %q", DesktopStartRefusalLoginWindow, result.Error)
	}
	if !strings.Contains(result.Error, "VNC Relay") {
		t.Fatalf("refusal must point the technician to VNC Relay, got %q", result.Error)
	}
}

func assertNotLoginWindowRefusal(t *testing.T, result tools.CommandResult) {
	t.Helper()
	if strings.Contains(result.Error, "("+DesktopStartRefusalLoginWindow+")") {
		t.Fatalf("start must not be refused as login_window, got %q", result.Error)
	}
}

func TestHandleStartDesktopRefusesAtMacLoginWindow(t *testing.T) {
	withDesktopStartHostOS(t, "darwin")
	h := loginWindowTestHeartbeat(t, "loginwindow")

	result := handleStartDesktop(h, startDesktopCmd("sess-login-window", consentModePrompt("block", 5000)))

	assertLoginWindowRefusal(t, result)
	// Refused before any side effect: no consent prompt, no recorded target.
	assertNotConsentDenied(t, result)
	h.mu.Lock()
	nTargets, nLeases := len(h.desktopTargets), len(h.desktopLeases)
	h.mu.Unlock()
	if nTargets != 0 || nLeases != 0 {
		t.Fatalf("refused start left state behind: %d targets, %d leases", nTargets, nLeases)
	}
}

func TestHandleStartDesktopAllowsMacUserSession(t *testing.T) {
	withDesktopStartHostOS(t, "darwin")
	h := loginWindowTestHeartbeat(t, "alice")

	result := handleStartDesktop(h, startDesktopCmd("sess-user-session", consentModePrompt("block", 5000)))

	assertNotLoginWindowRefusal(t, result)
	assertConsentDenied(t, result, "helper_absent")
}

// Before the darwin console watcher reports anything the console user is
// unknown. Refusing then would block every connect on a detection gap, so
// unknown keeps the pre-#7047 behavior.
func TestHandleStartDesktopAllowsUnknownMacConsoleUser(t *testing.T) {
	withDesktopStartHostOS(t, "darwin")
	h := loginWindowTestHeartbeat(t, "")

	result := handleStartDesktop(h, startDesktopCmd("sess-unknown-console", consentModePrompt("block", 5000)))

	assertNotLoginWindowRefusal(t, result)
	assertConsentDenied(t, result, "helper_absent")
}

// The gate is macOS-only: Windows drives the secure desktop and Winlogon
// through its own helper path, and "loginwindow" is never a console user there.
func TestHandleStartDesktopLoginWindowGateIsMacOnly(t *testing.T) {
	for _, goos := range []string{"windows", "linux"} {
		t.Run(goos, func(t *testing.T) {
			withDesktopStartHostOS(t, goos)
			h := loginWindowTestHeartbeat(t, "loginwindow")

			result := handleStartDesktop(h, startDesktopCmd("sess-gate-"+goos, consentModePrompt("block", 5000)))

			assertNotLoginWindowRefusal(t, result)
			assertConsentDenied(t, result, "helper_absent")
		})
	}
}

func TestHandleStartDesktopLoginWindowGateWithoutBroker(t *testing.T) {
	withDesktopStartHostOS(t, "darwin")
	h := &Heartbeat{desktopMgr: desktop.NewSessionManager()}

	result := handleStartDesktop(h, startDesktopCmd("sess-no-broker", consentModePrompt("block", 5000)))

	assertNotLoginWindowRefusal(t, result)
	assertConsentDenied(t, result, "helper_absent")
}
