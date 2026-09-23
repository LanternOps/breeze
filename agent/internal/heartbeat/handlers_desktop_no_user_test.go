package heartbeat

import (
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #6812: on an on-demand (RDS) host, a connect to a console nobody is signed
// into must not wait for a user-role helper that can never start. The viewer
// gives up on the answer after 15 s; the consent-helper wait was 30 s.

const noUserTargetSession = 2

var (
	noUserSystemKey = sessionbroker.HelperKey{WindowsSessionID: noUserTargetSession, Role: ipc.HelperRoleSystem}
	noUserUserKey   = sessionbroker.HelperKey{WindowsSessionID: noUserTargetSession, Role: ipc.HelperRoleUser}
)

func notifyModePrompt() *ipc.DesktopPrompt {
	return &ipc.DesktopPrompt{
		Mode:                       "notify",
		TechnicianName:             mustString("Test Tech"),
		ConsentUnavailableBehavior: "proceed",
		ShowIndicator:              true,
	}
}

// loggedOffConsoleLifecycle models the lab box: the console session exists
// (WTSConnected, Winlogon) but has no signed-in user, so no user-role helper
// can ever become ready — a wait on it only ends when its context does.
func loggedOffConsoleLifecycle() *fakeLifecycle {
	return &fakeLifecycle{
		mode:        "on-demand",
		unavailable: map[sessionbroker.HelperKey]bool{noUserUserKey: true},
		blockWait:   true,
	}
}

// runStartDesktopWithin runs handleStartDesktop and fails the test if it does
// not return inside budget — the regression this file guards is a wait that
// outlives the viewer's answer timeout.
func runStartDesktopWithin(t *testing.T, h *Heartbeat, cmd Command, budget time.Duration) tools.CommandResult {
	t.Helper()
	done := make(chan tools.CommandResult, 1)
	go func() { done <- handleStartDesktop(h, cmd) }()
	select {
	case result := <-done:
		return result
	case <-time.After(budget):
		t.Fatalf("start_desktop did not return within %s (consent-helper wait not skipped?)", budget)
		return tools.CommandResult{}
	}
}

func noUserStartCmd(sessionID string, prompt *ipc.DesktopPrompt) Command {
	cmd := startDesktopCmd(sessionID, prompt)
	cmd.Payload["targetSessionId"] = float64(noUserTargetSession)
	return cmd
}

func assertNoUserRoleLeaseOrWait(t *testing.T, f *fakeLifecycle) {
	t.Helper()
	acquired, _, waited, _ := f.snapshot()
	if len(acquired) != 1 || acquired[0] != noUserSystemKey {
		t.Fatalf("expected only the system-role lease, got %+v", acquired)
	}
	for _, k := range waited {
		if k.Role == ipc.HelperRoleUser {
			t.Fatalf("waited on a user-role helper the session cannot host: %+v", waited)
		}
	}
}

// Default notify mode: nobody is signed in to see the notice, so the connect
// goes straight to capture. It must not take a user-role lease or wait.
func TestHandleStartDesktopOnDemandNotifySkipsConsentWaitWhenNoUser(t *testing.T) {
	f := loggedOffConsoleLifecycle()
	h := &Heartbeat{
		helperLifecycle: f,
		sessionBroker:   newTestBrokerWithSessions(t),
		desktopMgr:      desktop.NewSessionManager(),
	}

	result := runStartDesktopWithin(t, h, noUserStartCmd("sess-notify-nouser", notifyModePrompt()), 5*time.Second)
	assertNotConsentDenied(t, result)
	assertNoUserRoleLeaseOrWait(t, f)
}

// Consent mode with consentUnavailableBehavior "block": nobody can consent, so
// the connect is denied at once with the helper_absent reason — it must never
// fall through to an allow, and must not sit out the wait first.
func TestHandleStartDesktopOnDemandConsentBlockDeniesFastWhenNoUser(t *testing.T) {
	f := loggedOffConsoleLifecycle()
	h := &Heartbeat{
		helperLifecycle: f,
		sessionBroker:   newTestBrokerWithSessions(t),
		desktopMgr:      desktop.NewSessionManager(),
	}

	result := runStartDesktopWithin(t, h, noUserStartCmd("sess-consent-block-nouser", consentModePrompt("block", 30000)), 5*time.Second)
	assertConsentDenied(t, result, "helper_absent")
	assertNoUserRoleLeaseOrWait(t, f)

	_, released, _, _ := f.snapshot()
	if len(released) != 1 || released[0] != noUserSystemKey {
		t.Fatalf("denial must release the system lease, got %+v", released)
	}
	h.mu.Lock()
	nLeases, nTargets := len(h.desktopLeases), len(h.desktopTargets)
	h.mu.Unlock()
	if nLeases != 0 || nTargets != 0 {
		t.Fatalf("leftover state: %d leases, %d targets", nLeases, nTargets)
	}
}

// Consent mode with "proceed": the configured fallback still governs; the fix
// only removes the pointless wait before it applies.
func TestHandleStartDesktopOnDemandConsentProceedAppliesPolicyWhenNoUser(t *testing.T) {
	f := loggedOffConsoleLifecycle()
	h := &Heartbeat{
		helperLifecycle: f,
		sessionBroker:   newTestBrokerWithSessions(t),
		desktopMgr:      desktop.NewSessionManager(),
	}

	result := runStartDesktopWithin(t, h, noUserStartCmd("sess-consent-proceed-nouser", consentModePrompt("proceed", 30000)), 5*time.Second)
	assertNotConsentDenied(t, result)
	assertNoUserRoleLeaseOrWait(t, f)
}

// A signed-in session keeps today's behavior: user-role lease plus the bounded
// head start for the consent helper.
func TestHandleStartDesktopOnDemandWaitsForConsentHelperWhenUserSignedIn(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{
		helperLifecycle: f,
		sessionBroker:   newTestBrokerWithSessions(t),
		desktopMgr:      desktop.NewSessionManager(),
	}

	result := runStartDesktopWithin(t, h, noUserStartCmd("sess-signed-in", consentModePrompt("block", 10)), 5*time.Second)
	assertConsentDenied(t, result, "helper_absent")

	acquired, _, waited, _ := f.snapshot()
	if len(acquired) != 2 || acquired[0] != noUserSystemKey || acquired[1] != noUserUserKey {
		t.Fatalf("expected system+user leases, got %+v", acquired)
	}
	if len(waited) != 1 || waited[0] != noUserUserKey {
		t.Fatalf("expected one wait on the user-role helper, got %+v", waited)
	}
}

// If the availability check itself fails, fall back to the previous behavior
// (lease + bounded wait) rather than guessing that nobody is signed in.
func TestHandleStartDesktopOnDemandAvailabilityErrorKeepsWait(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand", availableErr: errors.New("WTSEnumerateSessions failed")}
	h := &Heartbeat{
		helperLifecycle: f,
		sessionBroker:   newTestBrokerWithSessions(t),
		desktopMgr:      desktop.NewSessionManager(),
	}

	result := runStartDesktopWithin(t, h, noUserStartCmd("sess-check-err", consentModePrompt("block", 10)), 5*time.Second)
	assertConsentDenied(t, result, "helper_absent")

	acquired, _, waited, _ := f.snapshot()
	if len(acquired) != 2 {
		t.Fatalf("expected system+user leases on a failed check, got %+v", acquired)
	}
	if len(waited) != 1 || waited[0] != noUserUserKey {
		t.Fatalf("expected the user-role wait on a failed check, got %+v", waited)
	}
}

// Mode "off" never asks about the user role at all.
func TestHandleStartDesktopOnDemandPromptOffSkipsAvailabilityCheck(t *testing.T) {
	f := loggedOffConsoleLifecycle()
	h := &Heartbeat{
		helperLifecycle: f,
		sessionBroker:   newTestBrokerWithSessions(t),
		desktopMgr:      desktop.NewSessionManager(),
	}

	runStartDesktopWithin(t, h, noUserStartCmd("sess-off", &ipc.DesktopPrompt{Mode: "off"}), 5*time.Second)
	f.mu.Lock()
	checked := append([]sessionbroker.HelperKey(nil), f.checked...)
	f.mu.Unlock()
	if len(checked) != 0 {
		t.Fatalf("mode off must not query user-role availability, got %+v", checked)
	}
	assertNoUserRoleLeaseOrWait(t, f)
}
