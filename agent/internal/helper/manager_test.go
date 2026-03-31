package helper

import (
	"context"
	"os"
	"path/filepath"
	"testing"
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
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) error {
		spawned[sessionKey] = append([]string(nil), args...)
		statusPath := filepath.Join(tmpDir, "sessions", sessionKey, "helper_status.yaml")
		_ = os.MkdirAll(filepath.Dir(statusPath), 0755)
		return os.WriteFile(statusPath, []byte("version: 0.14.0\npid: 9001\n"), 0644)
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
