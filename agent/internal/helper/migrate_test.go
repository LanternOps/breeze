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
	mgr := New(context.Background(), "", nil, "")
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
	mgr := New(context.Background(), "", nil, "")
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
