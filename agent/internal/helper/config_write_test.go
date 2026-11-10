package helper

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

// helperConfigFixture is the exact output of the plain os.WriteFile
// implementation for helperConfigFixtureValue.
const helperConfigFixture = `show_open_portal: true
show_device_info: false
show_request_support: true
portal_url: https://portal.example.test
device_name: FRONT-DESK
device_status: online
last_checkin: "2026-11-04T12:00:00Z"
branding:
    scope_id: scope-1
    display_name: Example Co
`

func helperConfigFixtureValue() *Config {
	cfg := &Config{
		ShowOpenPortal:     true,
		ShowRequestSupport: true,
		PortalUrl:          "https://portal.example.test",
		DeviceName:         "FRONT-DESK",
		DeviceStatus:       "online",
		LastCheckin:        "2026-11-04T12:00:00Z",
		Branding:           &Branding{ScopeID: "scope-1"},
	}
	cfg.Branding.DisplayName = "Example Co"
	return cfg
}

const legacyConfigFixture = "show_open_portal: true\n"

// stubMigrationSeams keeps migrateToSessions away from the host. prepare runs
// where the real one hands the session directory to its user.
func stubMigrationSeams(t *testing.T, keys []string, prepare func(dir, key string) error) {
	t.Helper()
	origRemove, origStop, origTargets, origPrepare := removeAutoStartFunc, stopHelperLegacyFunc, migrationTargetsFunc, prepareSessionDirFunc
	t.Cleanup(func() {
		removeAutoStartFunc, stopHelperLegacyFunc, migrationTargetsFunc, prepareSessionDirFunc = origRemove, origStop, origTargets, origPrepare
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}
	migrationTargetsFunc = func() ([]string, error) { return keys, nil }
	prepareSessionDirFunc = prepare
}

func newMigrationManager(t *testing.T) (*Manager, string) {
	t.Helper()
	baseDir := t.TempDir()
	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	mgr.baseDir = baseDir
	mgr.sessionEnumerator = &mockEnumerator{}
	if err := os.WriteFile(filepath.Join(baseDir, "helper_config.yaml"), []byte(legacyConfigFixture), 0o600); err != nil {
		t.Fatal(err)
	}
	return mgr, baseDir
}

func assertNoTempLeftovers(t *testing.T, dir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "helper_config.*.yaml.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temp files left behind: %v", matches)
	}
}

func assertFileBytes(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte(want)) {
		t.Fatalf("%s content:\n%q\nwant:\n%q", path, got, want)
	}
}

func TestWriteSessionConfigMatchesFixture(t *testing.T) {
	baseDir := t.TempDir()
	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	state := newSessionState("501", baseDir)

	if err := mgr.writeSessionConfig(state, helperConfigFixtureValue(), SessionInfo{Key: "501"}); err != nil {
		t.Fatal(err)
	}

	assertFileBytes(t, state.configPath, helperConfigFixture)
	assertNoTempLeftovers(t, filepath.Dir(state.configPath))
	if state.lastConfig == nil || state.lastApplied.IsZero() {
		t.Fatalf("state not recorded: %+v", state)
	}
}

func TestWriteSessionConfigReplacesExistingFile(t *testing.T) {
	baseDir := t.TempDir()
	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	state := newSessionState("501", baseDir)
	if err := os.MkdirAll(filepath.Dir(state.configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state.configPath, []byte("stale: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := mgr.writeSessionConfig(state, helperConfigFixtureValue(), SessionInfo{Key: "501"}); err != nil {
		t.Fatal(err)
	}
	assertFileBytes(t, state.configPath, helperConfigFixture)
}

// A failed replace reports the error, removes its temp file and leaves
// lastConfig alone so the next heartbeat retries.
func TestWriteSessionConfigFailedReplaceCleansUp(t *testing.T) {
	baseDir := t.TempDir()
	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	state := newSessionState("501", baseDir)
	blocker := filepath.Join(state.configPath, "occupied")
	if err := os.MkdirAll(blocker, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := mgr.writeSessionConfig(state, helperConfigFixtureValue(), SessionInfo{Key: "501"}); err == nil {
		t.Fatal("expected an error replacing a non-empty directory")
	}

	assertNoTempLeftovers(t, filepath.Dir(state.configPath))
	if state.lastConfig != nil {
		t.Fatal("lastConfig recorded for a failed write")
	}
	if _, err := os.Stat(blocker); err != nil {
		t.Fatalf("existing directory disturbed: %v", err)
	}
}

func TestMigrateToSessionsConfigMatchesFixture(t *testing.T) {
	mgr, baseDir := newMigrationManager(t)
	stubMigrationSeams(t, []string{"501"}, func(string, string) error { return nil })

	mgr.migrateToSessions()

	sessionDir := filepath.Join(baseDir, "sessions", "501")
	assertFileBytes(t, filepath.Join(sessionDir, "helper_config.yaml"), legacyConfigFixture)
	assertNoTempLeftovers(t, sessionDir)
}

// One session that cannot take the file must not stop the others.
func TestMigrateToSessionsFailedReplaceCleansUpAndContinues(t *testing.T) {
	mgr, baseDir := newMigrationManager(t)
	stubMigrationSeams(t, []string{"501", "502"}, func(dir, key string) error {
		if key == "501" {
			return os.MkdirAll(filepath.Join(dir, "helper_config.yaml", "occupied"), 0o755)
		}
		return nil
	})

	mgr.migrateToSessions()

	assertNoTempLeftovers(t, filepath.Join(baseDir, "sessions", "501"))
	if _, err := os.Stat(filepath.Join(baseDir, "sessions", "501", "helper_config.yaml", "occupied")); err != nil {
		t.Fatalf("existing directory disturbed: %v", err)
	}
	assertFileBytes(t, filepath.Join(baseDir, "sessions", "502", "helper_config.yaml"), legacyConfigFixture)
}
