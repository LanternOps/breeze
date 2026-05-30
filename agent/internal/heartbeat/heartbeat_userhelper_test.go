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
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
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
	if _, err := os.Stat(tempDL); !os.IsNotExist(err) {
		t.Fatalf("temp download must be removed after a successful install, stat err=%v", err)
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

// --- atomicReplaceFile: never leave a truncated destination ---

// TestAtomicReplaceFile_Success: a normal install writes the full src bytes to
// dst and leaves no staging file behind.
func TestAtomicReplaceFile_Success(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	dst := filepath.Join(dir, "breeze-user-helper.exe")
	if err := os.WriteFile(src, []byte("NEWHELPER"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := atomicReplaceFile(src, dst); err != nil {
		t.Fatalf("atomicReplaceFile: %v", err)
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	if string(got) != "NEWHELPER" {
		t.Fatalf("dst content: want NEWHELPER, got %q", got)
	}
	if _, err := os.Stat(dst + ".new"); !os.IsNotExist(err) {
		t.Fatalf("staging file must be cleaned up, stat err=%v", err)
	}
}

// TestAtomicReplaceFile_CopyFailLeavesDestIntact: this is the crux of the
// critical fix — when the copy fails (here: src does not exist), the existing
// dst binary must be left fully intact (NOT truncated) and no staging file may
// linger. The pre-fix copyFile would have already O_TRUNC'd dst.
func TestAtomicReplaceFile_CopyFailLeavesDestIntact(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "does-not-exist.bin")
	dst := filepath.Join(dir, "breeze-user-helper.exe")
	if err := os.WriteFile(dst, []byte("OLDHELPER-INTACT"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := atomicReplaceFile(src, dst); err == nil {
		t.Fatal("expected error when src is missing, got nil")
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("dst must still exist after failed replace: %v", err)
	}
	if string(got) != "OLDHELPER-INTACT" {
		t.Fatalf("dst must be untouched after failed replace, got %q", got)
	}
	if _, err := os.Stat(dst + ".new"); !os.IsNotExist(err) {
		t.Fatalf("staging file must be cleaned up on failure, stat err=%v", err)
	}
}

// --- reconcileUserHelper: additional branches ---

// TestReconcileUserHelper_UnexpectedStatError_NoDownload: a stat error that is
// NOT "file not found" (here ENOTDIR: the agent's "directory" is actually a
// regular file) is not a confirmed absence — reconciliation must skip rather
// than download and clobber over a binary it merely couldn't read.
func TestReconcileUserHelper_UnexpectedStatError_NoDownload(t *testing.T) {
	dir := t.TempDir()
	fakeDir := filepath.Join(dir, "agent-dir-that-is-a-file")
	if err := os.WriteFile(fakeDir, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	binaryPath := filepath.Join(fakeDir, "breeze-agent.exe")

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
		t.Fatalf("unexpected stat error must skip; downloader=%d installer=%d", dlCalls.Load(), instCalls.Load())
	}
}

// TestReconcileUserHelper_ZeroLengthHelper_Refetches: a zero-length helper on
// disk (a previous interrupted/truncated install) must be treated as absent and
// re-fetched, not accepted as "present" — otherwise the corpse blocks self-heal
// forever.
func TestReconcileUserHelper_ZeroLengthHelper_Refetches(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent.exe")
	if err := os.WriteFile(filepath.Join(dir, "breeze-user-helper.exe"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	var instCalls atomic.Int32
	h := &Heartbeat{
		config:               &config.Config{},
		agentVersion:         "1.2.3",
		userHelperGOOS:       "windows",
		userHelperDownloader: func(string) (string, error) { return tempDL, nil },
		userHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileUserHelper(binaryPath)

	if instCalls.Load() != 1 {
		t.Fatalf("zero-length helper must trigger re-fetch+install; installer calls=%d", instCalls.Load())
	}
}

// TestReconcileUserHelper_InstallFails_NonFatal_RemovesTemp: a failed install is
// logged and non-fatal (no panic, no propagation), the downloaded temp file is
// still cleaned up (no slow temp leak across repeated failing ticks), and the
// consecutive-failure counter advances.
func TestReconcileUserHelper_InstallFails_NonFatal_RemovesTemp(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent.exe")
	tempDL := filepath.Join(dir, "breeze-user-helper-dl-777")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := &Heartbeat{
		config:               &config.Config{},
		agentVersion:         "1.2.3",
		userHelperGOOS:       "windows",
		userHelperDownloader: func(string) (string, error) { return tempDL, nil },
		userHelperInstaller:  func(string, string, string) error { return errors.New("sharing violation") },
	}

	h.reconcileUserHelper(binaryPath) // must not panic

	if _, err := os.Stat(tempDL); !os.IsNotExist(err) {
		t.Fatalf("temp download must be removed after a failed install, stat err=%v", err)
	}
	if got := h.userHelperReconcileFailures.Load(); got != 1 {
		t.Fatalf("failure counter: want 1 after one install failure, got %d", got)
	}
}

// TestReconcileUserHelper_ConsecutiveFailures_TrackedAndReset: repeated download
// failures advance the counter (which drives WARN→ERROR escalation), and the
// first success resets it to zero.
func TestReconcileUserHelper_ConsecutiveFailures_TrackedAndReset(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent.exe")
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	failDownload := true
	h := &Heartbeat{
		config:         &config.Config{},
		agentVersion:   "1.2.3",
		userHelperGOOS: "windows",
		userHelperDownloader: func(string) (string, error) {
			if failDownload {
				return "", errors.New("404 not found")
			}
			return tempDL, nil
		},
		userHelperInstaller: func(string, string, string) error { return nil },
	}

	h.reconcileUserHelper(binaryPath)
	h.reconcileUserHelper(binaryPath)
	if got := h.userHelperReconcileFailures.Load(); got != 2 {
		t.Fatalf("failure counter: want 2 after two download failures, got %d", got)
	}

	failDownload = false
	h.reconcileUserHelper(binaryPath)
	if got := h.userHelperReconcileFailures.Load(); got != 0 {
		t.Fatalf("failure counter: want reset to 0 after success, got %d", got)
	}
}
