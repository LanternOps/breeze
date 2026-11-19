package helper

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// #10755: a helper launch WITHOUT --config means "a person opened Assist" —
// the helper shows its main window, or signals an already-running instance to
// show it (#8138). The agent used to drop --config whenever it could not read
// the installed helper version, so an agent-driven logon spawn (or a duplicate
// spawn against a hidden, running Assist) popped the window open. Only a helper
// KNOWN to predate --config may be spawned without it.

type spawnRecorder struct {
	mu    sync.Mutex
	calls [][]string
}

func (r *spawnRecorder) spawn(_ string, _ string, args ...string) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, append([]string(nil), args...))
	return 7100 + len(r.calls), nil
}

func (r *spawnRecorder) snapshot() [][]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]string(nil), r.calls...)
}

func newSpawnIntentManager(t *testing.T, versionFn func(string) (string, error)) (*Manager, *spawnRecorder) {
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

	helperBinary := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(helperBinary, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	// sessions/ exists: the legacy root status is never consulted, so a fresh
	// logon session with no per-session status yet leaves the version unknown.
	if err := os.MkdirAll(filepath.Join(tmpDir, "sessions"), 0755); err != nil {
		t.Fatal(err)
	}

	rec := &spawnRecorder{}
	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	mgr.baseDir = tmpDir
	mgr.binaryPath = helperBinary
	mgr.sessionEnumerator = &mockEnumerator{sessions: []SessionInfo{{Key: "3", Username: "bob", UID: 503}}}
	mgr.isOurProcessFunc = func(int, string) bool { return false }
	mgr.stopIfOursFunc = func(int, string) (bool, error) { return false, nil }
	mgr.spawnFunc = rec.spawn
	mgr.binaryVersionFunc = versionFn
	return mgr, rec
}

func assertEverySpawnCarriesConfig(t *testing.T, mgr *Manager, calls [][]string) {
	t.Helper()
	if len(calls) == 0 {
		t.Fatal("expected the helper to be spawned")
	}
	want := filepath.Join(mgr.baseDir, "sessions", "3", "helper_config.yaml")
	for i, args := range calls {
		if len(args) != 2 || args[0] != "--config" || args[1] != want {
			t.Fatalf("spawn %d args = %v, want [--config %s] so Assist starts hidden", i, args, want)
		}
	}
}

func TestSpawnCarriesConfigWhenHelperVersionUnknown(t *testing.T) {
	cases := []struct {
		name    string
		version func(string) (string, error)
	}{
		{"binary version unreadable", func(string) (string, error) {
			return "", errors.New("GetFileVersionInfoSize: access denied")
		}},
		{"platform has no binary version", func(string) (string, error) {
			return "", errBinaryVersionUnsupported
		}},
		{"binary version blank", func(string) (string, error) { return "  ", nil }},
		// Readable but unparseable is not "known to be old" either.
		{"version not semver", func(string) (string, error) { return "dev", nil }},
		{"version two-part", func(string) (string, error) { return "0.14", nil }},
		// The first helper that reads --config.
		{"version at minimum", func(string) (string, error) { return "0.14.0", nil }},
		{"prerelease of minimum", func(string) (string, error) { return "v0.14.0-rc1", nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mgr, rec := newSpawnIntentManager(t, tc.version)
			mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})
			mgr.Shutdown()
			assertEverySpawnCarriesConfig(t, mgr, rec.snapshot())
		})
	}
}

// While the version is unknown the shared legacy root config is still written.
// That keeps a genuinely pre-0.14 helper whose version cannot be read
// configured, on the assumption (not verified against such old builds) that it
// ignores the --config argument it is now given.
func TestLegacyConfigStillWrittenWhileHelperVersionUnknown(t *testing.T) {
	mgr, _ := newSpawnIntentManager(t, func(string) (string, error) {
		return "", errors.New("GetFileVersionInfoSize: access denied")
	})
	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})
	mgr.Shutdown()
	if _, err := os.Stat(mgr.legacyConfigPath()); err != nil {
		t.Fatalf("legacy config not written while version unknown: %v", err)
	}
}

// Version-knowledge order must not matter: unknown at logon then known on a
// respawn, and known then unreadable on a respawn, both spawn hidden.
func TestSpawnStaysHiddenAcrossVersionKnowledgeChanges(t *testing.T) {
	unknown := func(string) (string, error) { return "", errors.New("sharing violation") }
	known := func(string) (string, error) { return "0.125.0", nil }
	orders := []struct {
		name          string
		first, second func(string) (string, error)
	}{
		{"unknown then known", unknown, known},
		{"known then unknown", known, unknown},
	}
	for _, o := range orders {
		t.Run(o.name, func(t *testing.T) {
			mgr, rec := newSpawnIntentManager(t, o.first)
			mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})
			first := len(rec.snapshot())
			if first == 0 {
				t.Fatal("expected a first spawn")
			}

			// The first Assist died (isOurProcessFunc reports false); the next
			// heartbeat respawns it under the second version reading.
			mgr.mu.Lock()
			mgr.binaryVersionFunc = o.second
			mgr.mu.Unlock()
			mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})
			mgr.Shutdown()

			calls := rec.snapshot()
			if len(calls) <= first {
				t.Fatalf("expected a respawn after the first Assist exited; spawns = %v", calls)
			}
			assertEverySpawnCarriesConfig(t, mgr, calls)
		})
	}
}

func TestSpawnOmitsConfigOnlyForHelperKnownToPredateIt(t *testing.T) {
	for _, v := range []string{"0.13.9", "v0.13.9-beta"} {
		t.Run(v, func(t *testing.T) {
			mgr, rec := newSpawnIntentManager(t, func(string) (string, error) { return v, nil })
			mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})
			mgr.Shutdown()

			calls := rec.snapshot()
			if len(calls) == 0 {
				t.Fatal("expected the helper to be spawned")
			}
			for i, args := range calls {
				if len(args) != 0 {
					t.Fatalf("spawn %d args = %v, want none for a helper older than %v", i, args, minConfigFlagVersion)
				}
			}
		})
	}
}
