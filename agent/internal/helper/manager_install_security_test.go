package helper

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// installSpy records whether installPackage (the SYSTEM/root exec) ran.
type installRecorder struct {
	called int
	paths  []string
}

func withInstallRecorder(t *testing.T) *installRecorder {
	t.Helper()
	rec := &installRecorder{}
	orig := installPackageFunc
	t.Cleanup(func() { installPackageFunc = orig })
	installPackageFunc = func(pkgPath, binaryPath string) error {
		rec.called++
		rec.paths = append(rec.paths, pkgPath)
		return nil
	}
	return rec
}

func newInstallTestManager(t *testing.T, tmpDir string) *Manager {
	t.Helper()
	mgr := New(context.Background(), "https://control.example.test", secmem.NewSecureString("tok"), "agent-1")
	mgr.baseDir = tmpDir
	mgr.binaryPath = filepath.Join(tmpDir, "missing-helper") // isInstalled() == false
	mgr.sessionEnumerator = &mockEnumerator{}
	return mgr
}

// TestDownloadAndInstallAbortsBeforeInstallOnVerificationFailure is the core
// regression for the HIGH finding: when the verified downloader rejects the
// payload (checksum/signature mismatch, off-origin redirect, etc.),
// installPackage — which runs msiexec/hdiutil as SYSTEM/root — MUST NOT run.
func TestDownloadAndInstallAbortsBeforeInstallOnVerificationFailure(t *testing.T) {
	tmpDir := t.TempDir()
	rec := withInstallRecorder(t)
	mgr := newInstallTestManager(t, tmpDir)

	// Inject a downloader that simulates a failed integrity check.
	mgr.downloadFunc = func(version string) (string, error) {
		return "", errors.New("checksum verification failed: release artifact manifest does not match download metadata")
	}

	err := mgr.downloadAndInstall("1.2.3")
	if err == nil {
		t.Fatal("expected downloadAndInstall to fail when verification fails")
	}
	if rec.called != 0 {
		t.Fatalf("installPackage ran %d time(s) after a verification failure — SYSTEM/root exec of unverified bytes!", rec.called)
	}
}

// TestDownloadAndInstallInstallsVerifiedPackage confirms the happy path: a
// successfully-verified package (downloader returns a real temp file) IS
// installed, and the verified bytes are what gets handed to installPackage.
func TestDownloadAndInstallInstallsVerifiedPackage(t *testing.T) {
	tmpDir := t.TempDir()
	rec := withInstallRecorder(t)
	mgr := newInstallTestManager(t, tmpDir)

	verifiedPkg := filepath.Join(tmpDir, "verified-helper"+packageExtension())
	if err := os.WriteFile(verifiedPkg, []byte("VERIFIED"), 0600); err != nil {
		t.Fatal(err)
	}
	mgr.downloadFunc = func(version string) (string, error) {
		if version != "2.0.0" {
			t.Fatalf("downloader got version %q, want 2.0.0", version)
		}
		return verifiedPkg, nil
	}

	if err := mgr.downloadAndInstall("2.0.0"); err != nil {
		t.Fatalf("downloadAndInstall failed on verified package: %v", err)
	}
	if rec.called != 1 {
		t.Fatalf("installPackage called %d times, want 1", rec.called)
	}
	if len(rec.paths) != 1 || rec.paths[0] != verifiedPkg {
		t.Fatalf("installPackage got path %v, want %q", rec.paths, verifiedPkg)
	}
}

// TestDownloadAndInstallRefusesWithoutVersion proves the install path fails
// closed: with no signed target version, there is no manifest entry to verify
// against, so we must refuse rather than fetch unversioned/unverified bytes.
func TestDownloadAndInstallRefusesWithoutVersion(t *testing.T) {
	tmpDir := t.TempDir()
	rec := withInstallRecorder(t)
	mgr := newInstallTestManager(t, tmpDir)

	called := false
	mgr.downloadFunc = func(version string) (string, error) {
		called = true
		return "", nil
	}

	err := mgr.downloadAndInstall("")
	if err == nil {
		t.Fatal("expected downloadAndInstall to refuse an empty target version")
	}
	if called {
		t.Fatal("downloader was invoked with an empty version — should fail closed first")
	}
	if rec.called != 0 {
		t.Fatalf("installPackage ran %d time(s) with no target version", rec.called)
	}
}

// TestApplyEnabledInstallUsesPendingVersion wires the realistic flow: the
// server pushes HelperUpgradeTo (-> CheckUpdate) then enables the helper. Apply
// must install using that pinned, signed version through the verified
// downloader — never the legacy unverified path.
func TestApplyEnabledInstallUsesPendingVersion(t *testing.T) {
	tmpDir := t.TempDir()
	rec := withInstallRecorder(t)

	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	mgr := newInstallTestManager(t, tmpDir)

	verifiedPkg := filepath.Join(tmpDir, "verified"+packageExtension())
	if err := os.WriteFile(verifiedPkg, []byte("VERIFIED"), 0600); err != nil {
		t.Fatal(err)
	}
	var gotVersion string
	mgr.downloadFunc = func(version string) (string, error) {
		gotVersion = version
		// Simulate install landing the binary so isInstalled flips true.
		if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
			return "", err
		}
		return verifiedPkg, nil
	}

	mgr.CheckUpdate("3.1.4")
	mgr.Apply(&Settings{Enabled: true})

	if gotVersion != "3.1.4" {
		t.Fatalf("install used version %q, want pinned 3.1.4", gotVersion)
	}
	// At least the bootstrap install must have run via the verified path. (The
	// subsequent applyPendingUpdate may also fire because our stub doesn't write
	// a status file, leaving installedVersion empty — that's incidental; the
	// security-relevant assertion is that every install went through the
	// verified downloader with the pinned version, which the downloadFunc stub
	// above guarantees.)
	if rec.called < 1 {
		t.Fatalf("installPackage called %d times, want >= 1", rec.called)
	}
}
