//go:build windows

package sessionbroker

import (
	"testing"
	"time"
)

func newWindowsLifecycleHarness(t *testing.T, sessions []DetectedSession) (*HelperLifecycleManager, *fakeHelperSpawner) {
	t.Helper()
	b := New(`\\.\pipe\lifecycle-`+t.Name(), nil)
	spawner := &fakeHelperSpawner{}
	m := newHelperLifecycleManager(b, fakeLifecycleDetector{sessions: sessions}, nil, spawner)
	m.gracePeriod = 0
	m.finalWait = 100 * time.Millisecond
	t.Cleanup(func() {
		m.Stop()
		b.Close()
	})
	return m, spawner
}

func TestHandleSCMEventDoesNotSpawnBeforeDetectorPublishesEventKey(t *testing.T) {
	m, spawner := newWindowsLifecycleHarness(t, []DetectedSession{{Session: "8", State: "active"}})
	m.handleSCMEvent(SCMSessionEvent{EventType: wtsSessionLogon, SessionID: 7})

	if got := spawner.SpawnCount(HelperKey{WindowsSessionID: 7, Role: "system"}); got != 0 {
		t.Fatalf("system spawn count = %d, want 0", got)
	}
	if got := spawner.SpawnCount(HelperKey{WindowsSessionID: 7, Role: "user"}); got != 0 {
		t.Fatalf("user spawn count = %d, want 0", got)
	}
}

func TestHandleSCMDisconnectStopsUserAndRetainsSystem(t *testing.T) {
	m, _ := newWindowsLifecycleHarness(t, []DetectedSession{{Session: "7", State: "disconnected", Type: "rdp"}})
	system := newFakeHelperProcess(6100)
	user := newFakeHelperProcess(6200)
	m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "system"}, system, "helper", "system-helper")
	m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "user"}, user, "helper", "user-helper")
	m.desired[HelperKey{WindowsSessionID: 7, Role: "system"}] = true
	m.desired[HelperKey{WindowsSessionID: 7, Role: "user"}] = true

	m.handleSCMEvent(SCMSessionEvent{EventType: wtsRemoteDisconnect, SessionID: 7})

	if !aliveNow(t, system) {
		t.Fatal("system helper was stopped on disconnect")
	}
	if aliveNow(t, user) {
		t.Fatal("user helper remained alive on disconnect")
	}
}

func TestHandleSCMLogoffAndTerminateStopBothRoles(t *testing.T) {
	for _, eventType := range []uint32{wtsSessionLogoff, wtsSessionTerminate} {
		t.Run(string(rune(eventType)), func(t *testing.T) {
			m, _ := newWindowsLifecycleHarness(t, nil)
			m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "system"}, newFakeHelperProcess(1), "helper", "system-helper")
			m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "user"}, newFakeHelperProcess(2), "helper", "user-helper")
			m.handleSCMEvent(SCMSessionEvent{EventType: eventType, SessionID: 7})
			if got := m.registry.len(); got != 0 {
				t.Fatalf("registry len = %d, want 0", got)
			}
		})
	}
}

func TestHandleSCMEventSkipsSessionZero(t *testing.T) {
	m, spawner := newWindowsLifecycleHarness(t, []DetectedSession{{Session: "0", State: "active", Type: "services"}})
	m.handleSCMEvent(SCMSessionEvent{EventType: wtsSessionLogon, SessionID: 0})
	if got := spawner.SpawnCount(HelperKey{WindowsSessionID: 0, Role: "system"}); got != 0 {
		t.Fatalf("session-zero spawn count = %d, want 0", got)
	}
}

func TestFatalExitCodeConsistency(t *testing.T) {
	if helperFatalExitCode != 2 {
		t.Fatalf("helperFatalExitCode = %d, want 2", helperFatalExitCode)
	}
}

func TestPanicExitCodeConsistency(t *testing.T) {
	if helperPanicExitCode != 3 || helperPanicExitCode == helperFatalExitCode {
		t.Fatalf("panic exit code = %d, fatal = %d", helperPanicExitCode, helperFatalExitCode)
	}
}

// TestHandleSCMRemoteConnectRestoresUserHelper covers reconnecting to an
// existing, previously-disconnected RDP session — the core flow of this branch.
//
// Windows fires WTS_REMOTE_CONNECT (0x3) for that, NOT logon/unlock/create: the
// session already exists and the user never logged off. Before this case
// existed, 0x3 fell through the switch and the user helper (which requires
// state=="active") came back only on the next 30s reconcile tick, so a
// reconnecting user sat without a helper for up to half a minute.
func TestHandleSCMRemoteConnectRestoresUserHelper(t *testing.T) {
	m, spawner := newWindowsLifecycleHarness(t, []DetectedSession{{Session: "7", State: "active", Type: "rdp"}})
	userKey := HelperKey{WindowsSessionID: 7, Role: "user"}

	m.handleSCMEvent(SCMSessionEvent{EventType: wtsRemoteConnect, SessionID: 7})

	if got := spawner.SpawnCount(userKey); got == 0 {
		t.Fatal("RDP reconnect did not spawn the user helper; it will not return until the next reconcile tick")
	}
}

// TestHandleSCMConsoleDisconnectStopsUserHelper covers switch-user / lock at the
// physical console, which fires WTS_CONSOLE_DISCONNECT (0x2). The constant
// formerly named wtsSessionDisconnect was really WTS_REMOTE_DISCONNECT (0x4)
// only, so the console case was unhandled and the user helper survived a
// console disconnect.
func TestHandleSCMConsoleDisconnectStopsUserHelper(t *testing.T) {
	m, _ := newWindowsLifecycleHarness(t, []DetectedSession{{Session: "7", State: "disconnected", Type: "console"}})
	system := newFakeHelperProcess(6300)
	user := newFakeHelperProcess(6400)
	m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "system"}, system, "helper", "system-helper")
	m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "user"}, user, "helper", "user-helper")
	m.desired[HelperKey{WindowsSessionID: 7, Role: "system"}] = true
	m.desired[HelperKey{WindowsSessionID: 7, Role: "user"}] = true

	m.handleSCMEvent(SCMSessionEvent{EventType: wtsConsoleDisconnect, SessionID: 7})

	if aliveNow(t, user) {
		t.Fatal("user helper survived a console disconnect")
	}
}
