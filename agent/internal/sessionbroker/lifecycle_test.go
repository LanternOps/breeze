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

	m.handleSCMEvent(SCMSessionEvent{EventType: wtsSessionDisconnect, SessionID: 7})

	if !system.Alive() {
		t.Fatal("system helper was stopped on disconnect")
	}
	if user.Alive() {
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
