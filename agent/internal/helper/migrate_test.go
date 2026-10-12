package helper

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNeedsSessionMigration(t *testing.T) {
	tmpDir := t.TempDir()
	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	mgr.baseDir = tmpDir

	if !mgr.needsSessionMigration() {
		t.Fatal("expected migration when sessions dir is absent")
	}

	if err := os.MkdirAll(filepath.Join(tmpDir, "sessions"), 0755); err != nil {
		t.Fatal(err)
	}
	if mgr.needsSessionMigration() {
		t.Fatal("did not expect migration once sessions dir exists")
	}
}

func TestMigrateToSessionsCreatesLayout(t *testing.T) {
	tmpDir := t.TempDir()
	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{
		sessions: []SessionInfo{{Key: "501", Username: "alice", UID: 501}},
	}

	if err := os.WriteFile(filepath.Join(tmpDir, "helper_config.yaml"), []byte("show_open_portal: true\n"), 0644); err != nil {
		t.Fatal(err)
	}

	origRemove := removeAutoStartFunc
	origStop := stopHelperLegacyFunc
	origTargets := migrationTargetsFunc
	origPrepare := prepareSessionDirFunc
	var removedAutoStart bool
	var stoppedLegacy bool
	var prepared []string
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStop
		migrationTargetsFunc = origTargets
		prepareSessionDirFunc = origPrepare
	})
	removeAutoStartFunc = func() error {
		removedAutoStart = true
		return nil
	}
	stopHelperLegacyFunc = func() { stoppedLegacy = true }
	migrationTargetsFunc = func() ([]string, error) { return []string{"501", "502"}, nil }
	prepareSessionDirFunc = func(path, sessionKey string) error {
		prepared = append(prepared, sessionKey)
		return nil
	}

	mgr.migrateToSessions()

	for _, key := range []string{"501", "502"} {
		sessionConfig := filepath.Join(tmpDir, "sessions", key, "helper_config.yaml")
		if _, err := os.Stat(sessionConfig); err != nil {
			t.Fatalf("session config missing for %s: %v", key, err)
		}
	}
	if !removedAutoStart {
		t.Fatal("expected autostart removal during migration")
	}
	if !stoppedLegacy {
		t.Fatal("expected legacy helper stop during migration")
	}
	if !reflect.DeepEqual(prepared, []string{"501", "502"}) {
		t.Fatalf("prepared sessions = %v, want [501 502]", prepared)
	}
}

// #8541: on Linux the legacy and current helper paths are the same file, so
// the legacy cleanup must leave the installed helper alone instead of
// stopping it and deleting it on every Apply.
func TestMigrateFromLegacyNameKeepsHelperWhenPathsMatch(t *testing.T) {
	tmpDir := t.TempDir()
	binary := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(binary, []byte("helper"), 0755); err != nil {
		t.Fatal(err)
	}

	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	mgr.baseDir = tmpDir
	mgr.binaryPath = binary

	origLegacy := legacyBinaryPathFunc
	t.Cleanup(func() { legacyBinaryPathFunc = origLegacy })
	legacyBinaryPathFunc = func() string { return binary }

	for i := 0; i < 3; i++ {
		mgr.migrateFromLegacyName()
		if _, err := os.Stat(binary); err != nil {
			t.Fatalf("call %d: installed helper was removed by legacy cleanup: %v", i+1, err)
		}
	}
}

func TestSamePath(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"/usr/local/bin/breeze-helper", "/usr/local/bin/breeze-helper", true},
		{"/usr/local/bin/../bin/breeze-helper", "/usr/local/bin/breeze-helper", true},
		{"/usr/local/bin/breeze-helper", "/usr/local/bin/Breeze Helper", false},
		{"", "/usr/local/bin/breeze-helper", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got := samePath(c.a, c.b); got != c.want {
			t.Errorf("samePath(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// #8541: drive the real entry point. A helper that is already installed at the
// legacy location must still be there after repeated Apply calls.
func TestApplyKeepsInstalledHelperWhenLegacyPathMatches(t *testing.T) {
	tmpDir := t.TempDir()
	binary := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(binary, []byte("helper"), 0755); err != nil {
		t.Fatal(err)
	}
	// Skip the one-time per-session migration; it is not under test here.
	if err := os.MkdirAll(filepath.Join(tmpDir, "sessions"), 0755); err != nil {
		t.Fatal(err)
	}

	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	mgr.baseDir = tmpDir
	mgr.binaryPath = binary

	origLegacy := legacyBinaryPathFunc
	origRemove := removeAutoStartFunc
	t.Cleanup(func() {
		legacyBinaryPathFunc = origLegacy
		removeAutoStartFunc = origRemove
	})
	legacyBinaryPathFunc = func() string { return binary }
	removeAutoStartFunc = func() error { return nil }

	for i := 0; i < 3; i++ {
		mgr.Apply(&Settings{Enabled: true})
		if _, err := os.Stat(binary); err != nil {
			t.Fatalf("Apply %d: installed helper was removed: %v", i+1, err)
		}
	}
}
