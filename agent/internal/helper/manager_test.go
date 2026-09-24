package helper

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
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

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{{Key: "501", Username: "alice", UID: 501}},
	}
	mgr.stopIfOursFunc = func(pid int, binaryPath string) (bool, error) {
		stopped++
		if pid != 4242 {
			t.Fatalf("stopIfOurs called with pid %d, want 4242", pid)
		}
		return true, nil
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
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{{Key: "501", Username: "alice", UID: 501}},
	}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return pid == 4242 }
	mgr.stopIfOursFunc = func(pid int, binaryPath string) (bool, error) { stopped++; return true, nil }
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
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{{Key: "501", Username: "alice", UID: 501}},
	}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return pid == os.Getpid() }
	mgr.stopIfOursFunc = func(pid int, binaryPath string) (bool, error) { stopped++; return true, nil }
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

	mgr := New(context.Background(), nil, nil, "")
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

	mgr := New(context.Background(), nil, nil, "")
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

	mgr := New(context.Background(), nil, nil, "")
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

func TestApplySweepsLegacyAutoStartOncePerProcess(t *testing.T) {
	tmpDir := t.TempDir()

	var removeCalls int
	origRemove := removeAutoStartFunc
	origSweep := sweepLegacyAutoStart
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		sweepLegacyAutoStart = origSweep
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { removeCalls++; return nil }
	stopHelperLegacyFunc = func() {}
	sweepLegacyAutoStart = true // simulate Windows on any test platform

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	// Pin to a non-existent path inside tmpDir so wasInstalled is deterministic
	// (false) regardless of whether the platform-default helper binary path
	// happens to exist on the machine running this test.
	mgr.binaryPath = filepath.Join(tmpDir, "breeze-helper")
	mgr.sessionEnumerator = &mockEnumerator{}

	mgr.Apply(&Settings{Enabled: false})
	mgr.Apply(&Settings{Enabled: false})

	// One sweep per process lifetime — not one per heartbeat tick. (The
	// migration/uninstall paths have their own removeAutoStartFunc calls;
	// with Enabled=false and no residual state those do not fire here.)
	if removeCalls != 1 {
		t.Fatalf("removeAutoStartFunc called %d times, want exactly 1", removeCalls)
	}
}

func TestApplySkipsLegacyAutoStartSweepOffWindows(t *testing.T) {
	tmpDir := t.TempDir()

	var removeCalls int
	origRemove := removeAutoStartFunc
	origSweep := sweepLegacyAutoStart
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		sweepLegacyAutoStart = origSweep
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { removeCalls++; return nil }
	stopHelperLegacyFunc = func() {}
	sweepLegacyAutoStart = false

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	// Pin to a non-existent path inside tmpDir so wasInstalled is deterministic
	// (false) regardless of whether the platform-default helper binary path
	// happens to exist on the machine running this test.
	mgr.binaryPath = filepath.Join(tmpDir, "breeze-helper")
	mgr.sessionEnumerator = &mockEnumerator{}

	mgr.Apply(&Settings{Enabled: false})

	if removeCalls != 0 {
		t.Fatalf("removeAutoStartFunc called %d times, want 0 when sweep disabled", removeCalls)
	}
}

// After an agent upgrade, m.sessions starts empty in memory. If a helper was
// spawned into a non-console (RDP) session before the upgrade, the
// console-only enumerator never surfaces that session key, so the pre-upgrade
// helper would otherwise run unmanaged until logoff and its sessions/<key> dir
// would linger. Apply must merge on-disk session directories into
// consideration so the stale-session sweep stops it.
func TestApplyReapsOnDiskSessionNotSurfacedByEnumerator(t *testing.T) {
	tmpDir := t.TempDir()
	staleStatusPath := filepath.Join(tmpDir, "sessions", "999", "helper_status.yaml")
	if err := os.MkdirAll(filepath.Dir(staleStatusPath), 0755); err != nil {
		t.Fatal(err)
	}
	// Simulates a pre-upgrade breeze-helper.exe still running in RDP session 999.
	if err := os.WriteFile(staleStatusPath, []byte("version: 0.13.0\npid: 4242\n"), 0644); err != nil {
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

	var stoppedPIDs []int
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	// Console-only enumerator: only the interactive console session surfaces,
	// never the RDP session 999 that owns the stale on-disk state.
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{{Key: "501", Username: "alice", UID: 501}},
	}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return false }
	mgr.stopIfOursFunc = func(pid int, binaryPath string) (bool, error) {
		stoppedPIDs = append(stoppedPIDs, pid)
		return true, nil
	}
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
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

	if _, exists := mgr.sessions["999"]; exists {
		t.Fatal("test setup: session 999 must start absent from the in-memory map")
	}

	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})

	found := false
	for _, pid := range stoppedPIDs {
		if pid == 4242 {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected stop path to run for on-disk stale session 999 (pid 4242), stopped pids: %v", stoppedPIDs)
	}
	if _, exists := mgr.sessions["999"]; exists {
		t.Fatal("stale on-disk session 999 should be removed from the map once stopped")
	}
}

// #3202: the tray-icon visibility flag must reach the per-session YAML the
// Tauri helper reads (`show_tray_icon`), otherwise the policy is a no-op.
func TestSettingsToConfigCarriesShowTrayIcon(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
	}{
		{"visible", true},
		{"hidden", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := settingsToConfig(&Settings{Enabled: true, ShowTrayIcon: tc.want})
			if cfg.ShowTrayIcon != tc.want {
				t.Fatalf("ShowTrayIcon = %v, want %v", cfg.ShowTrayIcon, tc.want)
			}
			data, err := yaml.Marshal(cfg)
			if err != nil {
				t.Fatal(err)
			}
			want := fmt.Sprintf("show_tray_icon: %v", tc.want)
			if !strings.Contains(string(data), want) {
				t.Fatalf("marshalled config %q missing %q", string(data), want)
			}
		})
	}
}

// A tray-icon-only change must count as a config change; otherwise
// configUnchanged short-circuits Apply and the helper is never restarted with
// the new YAML (the #1382 restart path).
func TestConfigUnchangedDetectsTrayIconFlip(t *testing.T) {
	state := newSessionState("501", t.TempDir())
	state.lastConfig = &Config{ShowTrayIcon: true, ShowOpenPortal: true}

	if !state.configUnchanged(&Config{ShowTrayIcon: true, ShowOpenPortal: true}) {
		t.Fatal("identical config reported as changed")
	}
	if state.configUnchanged(&Config{ShowTrayIcon: false, ShowOpenPortal: true}) {
		t.Fatal("tray-icon flip reported as unchanged — helper would never restart")
	}
}

func TestInstalledVersionSessionStatus(t *testing.T) {
	tmpDir := t.TempDir()
	sessionDir := filepath.Join(tmpDir, "sessions", "100")
	if err := os.MkdirAll(sessionDir, 0755); err != nil {
		t.Fatal(err)
	}
	sessionStatus := filepath.Join(sessionDir, "helper_status.yaml")
	if err := os.WriteFile(sessionStatus, []byte("version: 0.113.0\npid: 1234\n"), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.sessions["100"] = newSessionState("100", tmpDir)

	if got := mgr.InstalledVersion(); got != "0.113.0" {
		t.Fatalf("InstalledVersion() = %q, want %q", got, "0.113.0")
	}
}

func TestInstalledVersionLegacyFallback(t *testing.T) {
	tmpDir := t.TempDir()
	// Legacy status written at the root of baseDir next to agent.yaml with no sessions/ directory
	legacyStatus := filepath.Join(tmpDir, "helper_status.yaml")
	if err := os.WriteFile(legacyStatus, []byte("version: 0.111.1\npid: 5678\n"), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir

	if got := mgr.InstalledVersion(); got != "0.111.1" {
		t.Fatalf("InstalledVersion() fallback = %q, want %q", got, "0.111.1")
	}
}

func TestInstalledVersionLegacyFallbackIgnoredWhenSessionsDirExists(t *testing.T) {
	tmpDir := t.TempDir()
	// Legacy status left behind at the root of baseDir
	legacyStatus := filepath.Join(tmpDir, "helper_status.yaml")
	if err := os.WriteFile(legacyStatus, []byte("version: 0.111.1\npid: 5678\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// A sessions/ directory exists on disk (per-session helper has run)
	if err := os.MkdirAll(filepath.Join(tmpDir, "sessions"), 0755); err != nil {
		t.Fatal(err)
	}

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir

	// With sessions dir present, legacy root status must not be read to prevent stale update loops
	if got := mgr.InstalledVersion(); got != "" {
		t.Fatalf("InstalledVersion() = %q, want empty string when sessions directory exists", got)
	}
}

func TestInstalledVersionEmptyWhenNoStatus(t *testing.T) {
	tmpDir := t.TempDir()
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.sessions["100"] = newSessionState("100", tmpDir)

	if got := mgr.InstalledVersion(); got != "" {
		t.Fatalf("InstalledVersion() = %q, want empty string", got)
	}
}

// #6252: the on-disk binary version is authoritative. A helper session whose
// status file has not been written yet (e.g. a fresh Windows session id after
// logoff/logon) used to make InstalledVersion() return "" while the binary was
// on disk — the heartbeat downgrade guard then refused every server-directed
// update as invalid_current, forever.
func TestInstalledVersionPrefersOnDiskBinaryVersion(t *testing.T) {
	tmpDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmpDir, "sessions", "2"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.binaryPath = filepath.Join(tmpDir, "breeze-helper.exe")
	mgr.sessions["2"] = newSessionState("2", tmpDir) // no status file
	mgr.binaryVersionFunc = func(path string) (string, error) {
		if path != mgr.binaryPath {
			t.Fatalf("binaryVersionFunc got %q, want %q", path, mgr.binaryPath)
		}
		return "0.108.0", nil
	}

	if got := mgr.InstalledVersion(); got != "0.108.0" {
		t.Fatalf("InstalledVersion() = %q, want on-disk 0.108.0", got)
	}
}

// The running helper's status can lag the installed binary (the new binary is
// on disk but the old process has not been restarted yet). Decisions about
// what is INSTALLED must use the binary, not the stale process.
func TestInstalledVersionOnDiskWinsOverSessionStatus(t *testing.T) {
	tmpDir := t.TempDir()
	statusPath := filepath.Join(tmpDir, "sessions", "1", "helper_status.yaml")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statusPath, []byte("version: 0.108.0\n"), 0644); err != nil {
		t.Fatal(err)
	}
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.sessions["1"] = newSessionState("1", tmpDir)
	mgr.binaryVersionFunc = func(string) (string, error) { return "0.114.0", nil }

	if got := mgr.InstalledVersion(); got != "0.114.0" {
		t.Fatalf("InstalledVersion() = %q, want on-disk 0.114.0", got)
	}
}

func TestInstalledVersionFallsBackToStatusWhenBinaryVersionUnreadable(t *testing.T) {
	tmpDir := t.TempDir()
	statusPath := filepath.Join(tmpDir, "sessions", "1", "helper_status.yaml")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statusPath, []byte("version: 0.113.0\n"), 0644); err != nil {
		t.Fatal(err)
	}
	for name, readErr := range map[string]error{
		"unsupported": errBinaryVersionUnsupported,
		"read error":  fmt.Errorf("no version resource"),
	} {
		t.Run(name, func(t *testing.T) {
			mgr := New(context.Background(), nil, nil, "")
			mgr.baseDir = tmpDir
			mgr.sessions["1"] = newSessionState("1", tmpDir)
			mgr.binaryVersionFunc = func(string) (string, error) { return "", readErr }
			if got := mgr.InstalledVersion(); got != "0.113.0" {
				t.Fatalf("InstalledVersion() = %q, want status fallback 0.113.0", got)
			}
		})
	}
}

// #6252 chicken-and-egg: with no readable status, helperSupportsConfigFlag
// was false, so the helper was spawned WITHOUT --config and wrote its status
// to the legacy root file — which the agent ignores once sessions/ exists —
// so the version stayed unknown forever. With the on-disk version known, the
// spawn must carry --config for the per-session path.
func TestApplySpawnsWithConfigWhenOnlyOnDiskVersionKnown(t *testing.T) {
	tmpDir := t.TempDir()
	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	helperBinary := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(helperBinary, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(tmpDir, "sessions"), 0755); err != nil {
		t.Fatal(err)
	}

	var spawnArgs [][]string
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.binaryPath = helperBinary
	mgr.sessionEnumerator = &mockEnumerator{sessions: []SessionInfo{{Key: "3", Username: "bob", UID: 503}}}
	mgr.isOurProcessFunc = func(int, string) bool { return false }
	mgr.stopIfOursFunc = func(int, string) (bool, error) { return false, nil }
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
		spawnArgs = append(spawnArgs, append([]string(nil), args...))
		return 7001, nil
	}
	mgr.binaryVersionFunc = func(string) (string, error) { return "0.108.0", nil }

	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})
	mgr.Shutdown()

	if len(spawnArgs) == 0 {
		t.Fatal("expected the helper to be spawned")
	}
	if len(spawnArgs[0]) < 2 || spawnArgs[0][0] != "--config" {
		t.Fatalf("spawn args = %v, want --config <session path>", spawnArgs[0])
	}
}

// newNotInstalledManager builds a manager whose binaryPath does not exist
// and whose spawnFunc records every call — the #6872 fixture.
func newNotInstalledManager(t *testing.T) (*Manager, *int) {
	t.Helper()
	tmpDir := t.TempDir()
	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	spawns := 0
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.binaryPath = filepath.Join(tmpDir, "breeze-helper") // never written
	mgr.sessionEnumerator = &mockEnumerator{sessions: []SessionInfo{{Key: "1", Username: "kit", UID: 1}}}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return false }
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
		spawns++
		return 4242, nil
	}
	return mgr, &spawns
}

func TestEnsureRunningSessionReturnsErrNotInstalled(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)
	state := newSessionState("1", mgr.baseDir)

	mgr.mu.Lock()
	err := mgr.ensureRunningSession(state)
	mgr.mu.Unlock()

	if !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("err = %v, want ErrNotInstalled", err)
	}
	if *spawns != 0 {
		t.Fatalf("spawnFunc called %d times for a missing binary", *spawns)
	}
}

// A device that hit the watcher's give-up state must recover the moment the
// binary is installed: the not-installed check comes BEFORE watcherGaveUp.
func TestEnsureRunningSessionNotInstalledBeatsWatcherGaveUp(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)
	state := newSessionState("1", mgr.baseDir)
	state.watcherGaveUp = true

	mgr.mu.Lock()
	err := mgr.ensureRunningSession(state)
	mgr.mu.Unlock()
	if !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("err = %v, want ErrNotInstalled while missing", err)
	}

	// Install it: the stale give-up flag must not block the first spawn.
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	state.watcherGaveUp = false // applyPendingUpdate resets session state on install; mirror that
	mgr.mu.Lock()
	err = mgr.ensureRunningSession(state)
	mgr.mu.Unlock()
	if err != nil {
		t.Fatalf("post-install ensureRunningSession: %v", err)
	}
	if *spawns != 1 {
		t.Fatalf("spawnFunc called %d times after install, want 1", *spawns)
	}
}

func TestApplyEnabledNotInstalledNoPendingDoesNotSpawn(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)

	mgr.Apply(&Settings{Enabled: true})
	mgr.Apply(&Settings{Enabled: true})

	if *spawns != 0 {
		t.Fatalf("spawnFunc called %d times with no helper installed", *spawns)
	}
	for key, st := range mgr.sessions {
		if st.watcher != nil {
			t.Fatalf("session %s has a watcher with no helper installed", key)
		}
	}
	if !mgr.notInstalledWarned {
		t.Fatal("expected the not-installed warning to have fired once")
	}
}

func TestApplyNotInstalledWarnResetsWhenInstalledOrDisabled(t *testing.T) {
	mgr, _ := newNotInstalledManager(t)
	mgr.Apply(&Settings{Enabled: true})
	if !mgr.notInstalledWarned {
		t.Fatal("warn flag not set")
	}

	mgr.Apply(&Settings{Enabled: false})
	if mgr.notInstalledWarned {
		t.Fatal("warn flag must reset when the policy turns off")
	}

	mgr.Apply(&Settings{Enabled: true})
	if !mgr.notInstalledWarned {
		t.Fatal("warn flag not set on re-enable")
	}
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.Apply(&Settings{Enabled: true})
	if mgr.notInstalledWarned {
		t.Fatal("warn flag must reset once the binary is installed")
	}
}

// Binary removed while a session watcher is running: the next Apply must stop
// that watcher and spawn nothing.
func TestApplyNotInstalledStopsExistingWatcher(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.Apply(&Settings{Enabled: true})
	if *spawns != 1 {
		t.Fatalf("installed: spawnFunc called %d times, want 1", *spawns)
	}
	if mgr.sessions["1"] == nil || mgr.sessions["1"].watcher == nil {
		t.Fatal("expected a watcher for session 1 while installed")
	}

	if err := os.Remove(mgr.binaryPath); err != nil {
		t.Fatal(err)
	}
	mgr.Apply(&Settings{Enabled: true})
	if mgr.sessions["1"].watcher != nil {
		t.Fatal("watcher still running after the binary vanished")
	}
	if *spawns != 1 {
		t.Fatalf("spawnFunc called %d times after the binary vanished, want still 1", *spawns)
	}
}
