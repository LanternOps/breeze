package helper

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type mockEnumerator struct {
	sessions []SessionInfo
}

func (m *mockEnumerator) ActiveSessions() []SessionInfo {
	return append([]SessionInfo(nil), m.sessions...)
}

func TestApplyDisabledStopsRunningHelperAfterRestart(t *testing.T) {
	tmpDir := t.TempDir()
	statusPath := filepath.Join(tmpDir, "sessions", "501", "helper_status.yaml")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statusPath, []byte("version: 0.14.0\npid: 4242\n"), 0644); err != nil {
		t.Fatal(err)
	}

	stopped := 0
	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	mgr := New(context.Background(), "", nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{{Key: "501", Username: "alice", UID: 501}},
	}
	mgr.stopByPIDFunc = func(pid int) error {
		stopped++
		if pid != 4242 {
			t.Fatalf("stopByPID called with pid %d, want 4242", pid)
		}
		return nil
	}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return pid == 4242 }
	mgr.sessions["501"] = newSessionState("501", tmpDir)

	mgr.Apply(&Settings{Enabled: false})

	if stopped != 1 {
		t.Fatalf("stopByPID called %d times, want 1", stopped)
	}
	if _, exists := mgr.sessions["501"]; !exists {
		t.Fatal("disabled apply should keep active session state")
	}
}

// #1382: a running Breeze Assist helper only reads its config at spawn
// (--config), so a Configuration Policy change must restart it to take effect.
func TestApplyRestartsHelperOnConfigChangeWhenIdle(t *testing.T) {
	tmpDir := t.TempDir()
	statusPath := filepath.Join(tmpDir, "sessions", "501", "helper_status.yaml")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0755); err != nil {
		t.Fatal(err)
	}
	// chat_active false => idle, so the restart is allowed to proceed.
	if err := os.WriteFile(statusPath, []byte("version: 0.14.0\npid: 4242\nchat_active: false\n"), 0644); err != nil {
		t.Fatal(err)
	}

	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	stopped := 0
	spawned := 0
	mgr := New(context.Background(), "", nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{{Key: "501", Username: "alice", UID: 501}},
	}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return pid == 4242 }
	mgr.stopByPIDFunc = func(pid int) error { stopped++; return nil }
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
		spawned++
		_ = os.WriteFile(statusPath, []byte("version: 0.14.0\npid: 9001\n"), 0644)
		return 9001, nil
	}
	helperBinary := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(helperBinary, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.binaryPath = helperBinary

	// Seed a running session whose last-applied config differs from the new one.
	state := newSessionState("501", tmpDir)
	state.lastConfig = &Config{ShowOpenPortal: true}
	mgr.sessions["501"] = state

	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: false})

	if stopped != 1 {
		t.Fatalf("stopByPID called %d times, want 1 (restart on config change)", stopped)
	}
	if spawned != 1 {
		t.Fatalf("spawn called %d times, want 1 (respawn with new config)", spawned)
	}
}

// #1382: do not restart (and drop the chat) while a conversation is active.
// The new config is written to disk and applied on a later idle heartbeat.
func TestApplyDefersRestartWhileChatActive(t *testing.T) {
	tmpDir := t.TempDir()
	statusPath := filepath.Join(tmpDir, "sessions", "501", "helper_status.yaml")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0755); err != nil {
		t.Fatal(err)
	}
	// chat_active + recent activity + a real running pid (this test process) =>
	// IsIdle returns false, so the restart must be deferred.
	body := fmt.Sprintf("version: 0.14.0\npid: %d\nchat_active: true\nlast_activity: %s\n",
		os.Getpid(), time.Now().UTC().Format(time.RFC3339))
	if err := os.WriteFile(statusPath, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}

	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	stopped := 0
	spawned := 0
	mgr := New(context.Background(), "", nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{{Key: "501", Username: "alice", UID: 501}},
	}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return pid == os.Getpid() }
	mgr.stopByPIDFunc = func(pid int) error { stopped++; return nil }
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
		spawned++
		return 9001, nil
	}
	helperBinary := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(helperBinary, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.binaryPath = helperBinary

	state := newSessionState("501", tmpDir)
	state.lastConfig = &Config{ShowOpenPortal: true}
	mgr.sessions["501"] = state

	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: false})

	if stopped != 0 {
		t.Fatalf("restart should be deferred during active chat; stopByPID called %d times", stopped)
	}
	if spawned != 0 {
		t.Fatalf("helper should keep running during active chat; spawn called %d times", spawned)
	}
	// The new config must still be persisted so a later idle restart applies it.
	if state.lastConfig == nil || state.lastConfig.ShowOpenPortal != false {
		t.Fatal("new config should be written to disk even when restart is deferred")
	}
}

func TestApplyEnabledSpawnsPerSession(t *testing.T) {
	tmpDir := t.TempDir()
	spawned := map[string][]string{}
	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	mgr := New(context.Background(), "", nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{
			{Key: "501", Username: "alice", UID: 501},
			{Key: "502", Username: "bob", UID: 502},
		},
	}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return false }
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
		spawned[sessionKey] = append([]string(nil), args...)
		statusPath := filepath.Join(tmpDir, "sessions", sessionKey, "helper_status.yaml")
		_ = os.MkdirAll(filepath.Dir(statusPath), 0755)
		_ = os.WriteFile(statusPath, []byte("version: 0.14.0\npid: 9001\n"), 0644)
		return 9001, nil
	}

	helperBinary := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(helperBinary, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.binaryPath = helperBinary

	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})

	if len(spawned) != 2 {
		t.Fatalf("spawned %d sessions, want 2", len(spawned))
	}
	if _, ok := spawned["501"]; !ok {
		t.Fatal("missing spawn for session 501")
	}
	if _, ok := spawned["502"]; !ok {
		t.Fatal("missing spawn for session 502")
	}
}

func TestApplyDisabledUninstalledIsStableNoOp(t *testing.T) {
	tmpDir := t.TempDir()

	var removeCalls, uninstallCalls, stopLegacyCalls int
	origRemove := removeAutoStartFunc
	origUninstall := uninstallPackageFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		uninstallPackageFunc = origUninstall
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { removeCalls++; return nil }
	uninstallPackageFunc = func() error { uninstallCalls++; return nil }
	stopHelperLegacyFunc = func() { stopLegacyCalls++ }

	mgr := New(context.Background(), "", nil, "")
	mgr.baseDir = tmpDir
	mgr.binaryPath = filepath.Join(tmpDir, "breeze-helper") // absent → not installed
	mgr.sessionEnumerator = &mockEnumerator{}
	mgr.pendingHelperVersion = "1.2.3" // simulate bootstrap version arriving each tick

	mgr.Apply(&Settings{Enabled: false})
	mgr.Apply(&Settings{Enabled: false})

	if _, err := os.Stat(filepath.Join(tmpDir, "sessions")); !os.IsNotExist(err) {
		t.Fatalf("sessions dir should never be created when disabled+uninstalled; err=%v", err)
	}
	if removeCalls != 0 || uninstallCalls != 0 || stopLegacyCalls != 0 {
		t.Fatalf("expected zero cleanup churn, got remove=%d uninstall=%d stopLegacy=%d",
			removeCalls, uninstallCalls, stopLegacyCalls)
	}
	if mgr.pendingHelperVersion != "1.2.3" {
		t.Fatalf("pendingHelperVersion should survive disabled ticks, got %q", mgr.pendingHelperVersion)
	}
}

func TestApplyDisabledInstalledCleansUpOnce(t *testing.T) {
	tmpDir := t.TempDir()
	binPath := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(binPath, []byte("fake"), 0755); err != nil {
		t.Fatal(err)
	}

	var uninstallCalls int
	origRemove := removeAutoStartFunc
	origUninstall := uninstallPackageFunc
	origStopLegacy := stopHelperLegacyFunc
	origTargets := migrationTargetsFunc
	origPrepare := prepareSessionDirFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		uninstallPackageFunc = origUninstall
		stopHelperLegacyFunc = origStopLegacy
		migrationTargetsFunc = origTargets
		prepareSessionDirFunc = origPrepare
	})
	removeAutoStartFunc = func() error { return nil }
	uninstallPackageFunc = func() error { uninstallCalls++; _ = os.Remove(binPath); return nil }
	stopHelperLegacyFunc = func() {}
	migrationTargetsFunc = func() ([]string, error) { return nil, nil }
	prepareSessionDirFunc = func(path, sessionKey string) error { return nil }

	mgr := New(context.Background(), "", nil, "")
	mgr.baseDir = tmpDir
	mgr.binaryPath = binPath
	mgr.sessionEnumerator = &mockEnumerator{}

	mgr.Apply(&Settings{Enabled: false}) // installed → migrate once, then uninstall
	if uninstallCalls != 1 {
		t.Fatalf("first disabled tick should uninstall once, got %d", uninstallCalls)
	}
	mgr.Apply(&Settings{Enabled: false}) // now uninstalled → full no-op
	if uninstallCalls != 1 {
		t.Fatalf("second disabled tick should be a no-op, got %d uninstall calls", uninstallCalls)
	}
}
