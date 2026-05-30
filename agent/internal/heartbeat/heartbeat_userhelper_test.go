package heartbeat

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestPrefetchUserHelper_HappyPath covers the success branch: the injected
// downloader returns a temp path with no error, and prefetchUserHelper builds
// a *BinaryPair pointing the helper-restart script at
// <agent-dir>/breeze-user-helper.exe.
func TestPrefetchUserHelper_HappyPath(t *testing.T) {
	tempPath := filepath.Join(t.TempDir(), "breeze-user-helper-dl-12345")
	var calls atomic.Int32
	h := &Heartbeat{
		config:         &config.Config{},
		agentVersion:   "1.2.3",
		userHelperGOOS: "windows",
		userHelperDownloader: func(targetVersion string) (string, error) {
			calls.Add(1)
			if targetVersion != "1.2.4" {
				t.Fatalf("expected targetVersion=1.2.4, got %q", targetVersion)
			}
			return tempPath, nil
		},
	}

	binaryPath := "/opt/breeze/breeze-agent"
	pair := h.prefetchUserHelper("1.2.4", binaryPath)
	if pair == nil {
		t.Fatal("expected non-nil BinaryPair on happy path")
	}
	if pair.Temp != tempPath {
		t.Fatalf("Temp: expected %q, got %q", tempPath, pair.Temp)
	}
	wantTarget := filepath.Join(filepath.Dir(binaryPath), "breeze-user-helper.exe")
	if pair.Target != wantTarget {
		t.Fatalf("Target: expected %q, got %q", wantTarget, pair.Target)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("downloader call count: expected 1, got %d", got)
	}
}

// TestPrefetchUserHelper_DownloadFails covers the non-fatal failure branch:
// downloader returns an error (404 from pre-#816 release, transient network
// error, checksum mismatch, etc.). prefetchUserHelper must return nil so the
// caller proceeds with an agent-only upgrade — the entire reason PR #845
// exists.
func TestPrefetchUserHelper_DownloadFails(t *testing.T) {
	var calls atomic.Int32
	h := &Heartbeat{
		config:         &config.Config{},
		agentVersion:   "1.2.3",
		userHelperGOOS: "windows",
		userHelperDownloader: func(targetVersion string) (string, error) {
			calls.Add(1)
			return "", errors.New("404 status: not found")
		},
	}

	pair := h.prefetchUserHelper("1.2.4", "/opt/breeze/breeze-agent")
	if pair != nil {
		t.Fatalf("expected nil BinaryPair on download failure, got %+v", pair)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("downloader should be called exactly once even on failure, got %d", got)
	}
}

// TestPrefetchUserHelper_NonWindows verifies the prefetch is a no-op on
// non-Windows runtimes. Non-Windows agents never spawn user-helper sessions,
// so the download would be pointless work + needless server load.
func TestPrefetchUserHelper_NonWindows(t *testing.T) {
	var calls atomic.Int32
	for _, goos := range []string{"linux", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			h := &Heartbeat{
				config:         &config.Config{},
				agentVersion:   "1.2.3",
				userHelperGOOS: goos,
				userHelperDownloader: func(targetVersion string) (string, error) {
					calls.Add(1)
					return "/tmp/should-not-be-called", nil
				},
			}
			pair := h.prefetchUserHelper("1.2.4", "/opt/breeze/breeze-agent")
			if pair != nil {
				t.Fatalf("expected nil BinaryPair on non-Windows runtime %s, got %+v", goos, pair)
			}
		})
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("downloader must not be invoked on non-Windows runtimes, got %d calls", got)
	}
}

// TestPrefetchUserHelper_DefaultGOOSMatchesRuntime is a smoke test: when no
// override is set, the function falls back to runtime.GOOS. On non-Windows
// CI hosts this means a nil return without ever touching the network — which
// is exactly the safety property we want.
func TestPrefetchUserHelper_DefaultGOOSMatchesRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test asserts non-Windows runtime safety; would need network on Windows")
	}
	h := &Heartbeat{
		config:       &config.Config{},
		agentVersion: "1.2.3",
		// No userHelperGOOS override, no userHelperDownloader injection.
		// On a non-Windows host this must short-circuit before constructing
		// the real updater (which would otherwise try to hit ServerURL).
	}
	pair := h.prefetchUserHelper("1.2.4", "/opt/breeze/breeze-agent")
	if pair != nil {
		t.Fatalf("expected nil BinaryPair on non-Windows runtime, got %+v", pair)
	}
}

// --- reconcileUserHelper: decoupled self-heal of a missing helper binary ---

// TestReconcileUserHelper_NonWindows_NoOp: macOS/Linux have no sibling helper
// binary (the helper runs as a breeze-agent subcommand), so reconciliation must
// short-circuit before any download or install — even when the sibling path
// happens not to exist.
func TestReconcileUserHelper_NonWindows_NoOp(t *testing.T) {
	var dlCalls, instCalls atomic.Int32
	h := &Heartbeat{
		config:               &config.Config{},
		agentVersion:         "1.2.3",
		userHelperGOOS:       "darwin",
		userHelperDownloader: func(string) (string, error) { dlCalls.Add(1); return "", nil },
		userHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileUserHelper(filepath.Join(t.TempDir(), "breeze-agent"))

	if dlCalls.Load() != 0 || instCalls.Load() != 0 {
		t.Fatalf("non-windows must be a no-op; downloader=%d installer=%d", dlCalls.Load(), instCalls.Load())
	}
}

// TestReconcileUserHelper_Present_NoOp: when breeze-user-helper.exe already
// exists next to the agent there is nothing to heal — no download, no install.
func TestReconcileUserHelper_Present_NoOp(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent.exe")
	if err := os.WriteFile(filepath.Join(dir, "breeze-user-helper.exe"), []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	var dlCalls, instCalls atomic.Int32
	h := &Heartbeat{
		config:               &config.Config{},
		agentVersion:         "1.2.3",
		userHelperGOOS:       "windows",
		userHelperDownloader: func(string) (string, error) { dlCalls.Add(1); return "", nil },
		userHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileUserHelper(binaryPath)

	if dlCalls.Load() != 0 || instCalls.Load() != 0 {
		t.Fatalf("present helper must be a no-op; downloader=%d installer=%d", dlCalls.Load(), instCalls.Load())
	}
}

// TestReconcileUserHelper_Missing_DownloadsAndInstalls: the core self-heal path.
// A Windows agent missing the sibling helper fetches the CURRENT agent version
// (not "latest") and installs it next to the agent binary.
func TestReconcileUserHelper_Missing_DownloadsAndInstalls(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent.exe")
	tempDL := filepath.Join(dir, "breeze-user-helper-dl-999")
	wantInstall := filepath.Join(dir, "breeze-user-helper.exe")

	var instCalls atomic.Int32
	var gotDLVersion, gotTemp, gotInstallPath, gotInstallVersion string
	h := &Heartbeat{
		config:               &config.Config{},
		agentVersion:         "1.2.3",
		userHelperGOOS:       "windows",
		userHelperDownloader: func(v string) (string, error) { gotDLVersion = v; return tempDL, nil },
		userHelperInstaller: func(temp, installPath, version string) error {
			instCalls.Add(1)
			gotTemp, gotInstallPath, gotInstallVersion = temp, installPath, version
			return nil
		},
	}

	h.reconcileUserHelper(binaryPath)

	if gotDLVersion != "1.2.3" {
		t.Fatalf("download version: want current 1.2.3, got %q", gotDLVersion)
	}
	if instCalls.Load() != 1 {
		t.Fatalf("installer calls: want 1, got %d", instCalls.Load())
	}
	if gotTemp != tempDL {
		t.Fatalf("install temp: want %q, got %q", tempDL, gotTemp)
	}
	if gotInstallPath != wantInstall {
		t.Fatalf("install path: want %q, got %q", wantInstall, gotInstallPath)
	}
	if gotInstallVersion != "1.2.3" {
		t.Fatalf("install version: want 1.2.3, got %q", gotInstallVersion)
	}
}

// TestReconcileUserHelper_DownloadFails_NoInstall: a failed fetch (404 on a
// pre-#816 release, transient network error, checksum mismatch) is non-fatal —
// nothing is installed and the call returns without panicking.
func TestReconcileUserHelper_DownloadFails_NoInstall(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent.exe")
	var instCalls atomic.Int32
	h := &Heartbeat{
		config:               &config.Config{},
		agentVersion:         "1.2.3",
		userHelperGOOS:       "windows",
		userHelperDownloader: func(string) (string, error) { return "", errors.New("404 not found") },
		userHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileUserHelper(binaryPath)

	if instCalls.Load() != 0 {
		t.Fatalf("installer must not run when download fails; got %d calls", instCalls.Load())
	}
}
