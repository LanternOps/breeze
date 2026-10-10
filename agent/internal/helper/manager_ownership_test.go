package helper

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// ownershipCalls counts every machine-wide side effect Apply can reach.
type ownershipCalls struct {
	removeAutoStart int
	uninstall       int
	install         int
	download        int
	spawn           int
	stop            int
	stopLegacy      int
}

// ownershipFixture lays out an installed Assist under a temp base dir: the
// binary, one per-session dir with its config, and the legacy global config.
type ownershipFixture struct {
	baseDir       string
	binaryPath    string
	sessionConfig string
	legacyConfig  string
}

func newOwnershipFixture(t *testing.T, installed bool) ownershipFixture {
	t.Helper()
	dir := t.TempDir()
	f := ownershipFixture{
		baseDir:       dir,
		binaryPath:    filepath.Join(dir, "breeze-helper"),
		sessionConfig: filepath.Join(dir, "sessions", "1", "helper_config.yaml"),
		legacyConfig:  filepath.Join(dir, "helper_config.yaml"),
	}
	if !installed {
		return f
	}
	if err := os.WriteFile(f.binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(f.sessionConfig), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{f.sessionConfig, f.legacyConfig} {
		if err := os.WriteFile(p, []byte("show_tray_icon: true\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func stubMachineSeams(t *testing.T, calls *ownershipCalls, binaryPath string) {
	t.Helper()
	origRemove, origUninstall, origInstall := removeAutoStartFunc, uninstallPackageFunc, installPackageFunc
	origStopLegacy, origTargets, origPrepare := stopHelperLegacyFunc, migrationTargetsFunc, prepareSessionDirFunc
	origSweep := sweepLegacyAutoStart
	t.Cleanup(func() {
		removeAutoStartFunc, uninstallPackageFunc, installPackageFunc = origRemove, origUninstall, origInstall
		stopHelperLegacyFunc, migrationTargetsFunc, prepareSessionDirFunc = origStopLegacy, origTargets, origPrepare
		sweepLegacyAutoStart = origSweep
	})
	// Exercise the Windows-only legacy Run-key sweep on every host: it is one
	// of the machine-wide writes a non-owner must not make.
	sweepLegacyAutoStart = true
	removeAutoStartFunc = func() error { calls.removeAutoStart++; return nil }
	uninstallPackageFunc = func() error { calls.uninstall++; _ = os.Remove(binaryPath); return nil }
	installPackageFunc = func(string, string, string) error { calls.install++; return nil }
	stopHelperLegacyFunc = func() { calls.stopLegacy++ }
	migrationTargetsFunc = func() ([]string, error) { return nil, nil }
	prepareSessionDirFunc = func(string, string) error { return nil }
}

func newOwnershipManager(t *testing.T, f ownershipFixture, calls *ownershipCalls, opts ...Option) *Manager {
	t.Helper()
	mgr := New(context.Background(), func() string { return "https://control.example.test" }, secmem.NewSecureString("tok"), "agent-1", opts...)
	t.Cleanup(mgr.Shutdown)
	mgr.baseDir = f.baseDir
	mgr.binaryPath = f.binaryPath
	mgr.binaryVersionFunc = func(string) (string, error) { return "", errBinaryVersionUnsupported }
	mgr.sessionEnumerator = &mockEnumerator{sessions: []SessionInfo{{Key: "1", Username: "alice", UID: 501}}}
	mgr.isOurProcessFunc = func(int, string) bool { return false }
	mgr.stopIfOursFunc = func(int, string) (bool, error) { calls.stop++; return true, nil }
	mgr.spawnFunc = func(string, string, ...string) (int, error) { calls.spawn++; return 0, errors.New("spawn stubbed") }
	mgr.downloadFunc = func(string) (string, error) { calls.download++; return "", errors.New("download stubbed") }
	return mgr
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// A process that is not the installed agent (foreground run, a second build
// with its own config, a Quick Support client) receives its OWN server's
// Assist policy. It must never act on the host's machine-wide Assist install,
// whatever that policy says.
func TestApplyNonOwnerNeverMutatesMachineAssist(t *testing.T) {
	cases := []struct {
		name      string
		installed bool
		enabled   bool
		pending   string
	}{
		{name: "policy off, Assist installed by the installed agent", installed: true, enabled: false},
		{name: "policy on, Assist installed by the installed agent", installed: true, enabled: true},
		{name: "policy on, not installed, install offered", installed: false, enabled: true, pending: "1.2.3"},
		{name: "policy off, not installed", installed: false, enabled: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls ownershipCalls
			f := newOwnershipFixture(t, tc.installed)
			stubMachineSeams(t, &calls, f.binaryPath)
			mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(false))
			if tc.pending != "" {
				mgr.CheckUpdate(tc.pending)
			}

			mgr.Apply(&Settings{Enabled: tc.enabled, ShowOpenPortal: true})
			mgr.Apply(&Settings{Enabled: tc.enabled, ShowOpenPortal: true})

			if calls != (ownershipCalls{}) {
				t.Fatalf("non-owner touched machine-wide Assist state: %+v", calls)
			}
			if tc.installed {
				for _, p := range []string{f.binaryPath, f.sessionConfig, f.legacyConfig} {
					if !fileExists(p) {
						t.Fatalf("non-owner removed %s", p)
					}
				}
			} else if fileExists(filepath.Join(f.baseDir, "sessions")) {
				t.Fatal("non-owner created the per-session Assist layout")
			}
			if !mgr.nonOwnerNoticeLogged {
				t.Fatal("non-owner should log once that it is leaving Assist alone")
			}
		})
	}
}

// Control for the table above: the installed agent still owns the lifecycle.
// Without it the non-owner test could pass against a Manager that never does
// anything at all.
func TestApplyOwnerStillManagesMachineAssist(t *testing.T) {
	t.Run("policy off uninstalls", func(t *testing.T) {
		var calls ownershipCalls
		f := newOwnershipFixture(t, true)
		stubMachineSeams(t, &calls, f.binaryPath)
		mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))

		mgr.Apply(&Settings{Enabled: false})

		if calls.uninstall != 1 {
			t.Fatalf("owner uninstall calls = %d, want 1", calls.uninstall)
		}
		if fileExists(filepath.Join(f.baseDir, "sessions")) || fileExists(f.legacyConfig) {
			t.Fatal("owner uninstall should clear per-session state and the legacy config")
		}
	})
	t.Run("policy on with an offer installs", func(t *testing.T) {
		var calls ownershipCalls
		f := newOwnershipFixture(t, false)
		stubMachineSeams(t, &calls, f.binaryPath)
		mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))
		mgr.CheckUpdate("1.2.3")

		mgr.Apply(&Settings{Enabled: true})

		if calls.download != 1 {
			t.Fatalf("owner download calls = %d, want 1", calls.download)
		}
	})
	t.Run("policy on and installed spawns", func(t *testing.T) {
		var calls ownershipCalls
		f := newOwnershipFixture(t, true)
		stubMachineSeams(t, &calls, f.binaryPath)
		mgr := newOwnershipManager(t, f, &calls, WithMachineInstallOwner(true))

		mgr.Apply(&Settings{Enabled: true})

		if calls.spawn == 0 {
			t.Fatal("owner should spawn Assist into the active session")
		}
	})
}

// Fail closed: a Manager built without declaring ownership is not the owner.
func TestNewDefaultsToNotMachineInstallOwner(t *testing.T) {
	if New(context.Background(), nil, nil, "").ManagesMachineInstall() {
		t.Fatal("New without WithMachineInstallOwner must not own the machine-wide Assist install")
	}
	if !New(context.Background(), nil, nil, "", WithMachineInstallOwner(true)).ManagesMachineInstall() {
		t.Fatal("WithMachineInstallOwner(true) not applied")
	}
}

// The Assist base dir (sessions/, helper_config.yaml) is the agent's config
// dir, resolved the same way the agent resolves it, not a second copy of the
// platform path logic reading %ProgramData% from the environment.
func TestNewDerivesBaseDirFromAgentConfigDir(t *testing.T) {
	t.Setenv("ProgramData", t.TempDir())
	if got, want := New(context.Background(), nil, nil, "").baseDir, config.ConfigDir(); got != want {
		t.Fatalf("baseDir = %q, want the agent config dir %q", got, want)
	}
}
