package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func shInstallerCommand(ctx context.Context, script string) *exec.Cmd {
	return exec.CommandContext(ctx, "sh", "-c", script)
}

// Regression for the EXE-installer hang: a wrapper installer that spawns a
// background child (which inherits stdout/stderr) and then exits must not
// stall runInstallerCommand until that descendant exits — without WaitDelay,
// CombinedOutput blocks on pipe EOF until every handle-holding descendant is
// gone, so real-world EXE wrappers ran into the 30-minute install timeout.
func TestRunInstallerCommandReturnsWhenDescendantHoldsPipe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helper through sh")
	}
	prev := installerWaitDelay
	installerWaitDelay = 500 * time.Millisecond
	defer func() { installerWaitDelay = prev }()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	start := time.Now()
	exitCode, output, _, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "sleep 8 & echo wrapper-done"), "exe")
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("expected success after wrapper exit, got err=%v (exitCode=%d)", err, exitCode)
	}
	if exitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", exitCode)
	}
	if !strings.Contains(output, "wrapper-done") {
		t.Fatalf("expected captured wrapper output, got %q", output)
	}
	if elapsed > 4*time.Second {
		t.Fatalf("runInstallerCommand blocked on descendant process for %v; want prompt return after wrapper exit", elapsed)
	}
}

// A genuine install timeout must be reported as a timeout, not disguised as
// the kill's exit code ("installer exited with code 1" on Windows, -1 on
// unix), which is indistinguishable from a real installer failure.
func TestRunInstallerCommandLabelsTimeoutAsTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helper through sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	_, _, _, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "sleep 10"), "exe")
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout to be labeled as such, got err=%v", err)
	}
}

// A wrapper that exits 0 while a descendant still holds the output pipes can
// drain past the install deadline: the process is already gone, so the deadline
// killed nothing. Sampling ctx.Err() alone mislabeled that as a 30-minute
// timeout — a 10-second-wide window (installerWaitDelay) on exactly the
// wrapper-style installers this path exists to serve.
func TestRunInstallerCommandDoesNotMislabelLateSuccessAsTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helper through sh")
	}
	prev := installerWaitDelay
	installerWaitDelay = 2 * time.Second
	defer func() { installerWaitDelay = prev }()

	// The deadline expires while Wait is still draining the descendant's pipes,
	// long after the wrapper itself exited 0.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	exitCode, output, _, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "sleep 30 & echo wrapper-done"), "exe")
	if err != nil {
		t.Fatalf("expected success for a wrapper that exited 0, got err=%v (exitCode=%d)", err, exitCode)
	}
	if exitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", exitCode)
	}
	if !strings.Contains(output, "wrapper-done") {
		t.Fatalf("expected captured wrapper output, got %q", output)
	}
}

// A real non-zero installer exit must keep today's shape: the true exit code
// and the "installer exited with code N" error.
func TestRunInstallerCommandReportsRealExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helper through sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	exitCode, _, _, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "exit 3"), "exe")
	if exitCode != 3 {
		t.Fatalf("expected exit code 3, got %d", exitCode)
	}
	if err == nil || !strings.Contains(err.Error(), "installer exited with code 3") {
		t.Fatalf("expected exit-code error, got %v", err)
	}
}

// The ErrWaitDelay path means the wrapper exited while descendants — typically
// the REAL installer — kept running. Detection has to know, so it can wait for
// the software to land instead of failing the install as unsatisfied.
func TestRunInstallerCommandReportsDescendantsOutlivedWrapper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helper through sh")
	}
	prev := installerWaitDelay
	installerWaitDelay = 300 * time.Millisecond
	defer func() { installerWaitDelay = prev }()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_, _, descendantsPending, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "sleep 10 & echo wrapper-done"), "exe")
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if !descendantsPending {
		t.Fatal("expected descendantsPending=true when a descendant outlived the wrapper")
	}

	_, _, descendantsPending, err = runInstallerCommand(ctx, shInstallerCommand(ctx, "echo done"), "exe")
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if descendantsPending {
		t.Fatal("expected descendantsPending=false for an installer that left nothing behind")
	}
}

// When the wrapper's descendants are still installing, a single immediate
// detection check reports "installer reported success but detection rule was
// not satisfied" for an install that is merely still in flight. The settling
// path must re-check within its bound and pass as soon as the app appears.
func TestApplyPostInstallDetectionSettlesWhileDescendantsInstall(t *testing.T) {
	prevWindow := detectionSettleWindow
	prevInterval := detectionSettleInterval
	detectionSettleWindow = 5 * time.Second
	detectionSettleInterval = 50 * time.Millisecond
	defer func() {
		detectionSettleWindow = prevWindow
		detectionSettleInterval = prevInterval
	}()

	marker := filepath.Join(t.TempDir(), "late.txt")
	rules := []DetectionRule{{Type: "file_exists", Path: marker}}
	go func() {
		time.Sleep(300 * time.Millisecond)
		_ = os.WriteFile(marker, []byte("x"), 0o600)
	}()

	r := applyPostInstallDetectionSettling(map[string]any{"success": true}, 0, "out", rules, 0, true)
	if r.Status != "completed" {
		t.Fatalf("want completed once the descendant install lands, got %q (err=%q)", r.Status, r.Error)
	}
}

// The ordinary path must keep today's single-shot behavior and timing: a normal
// install that leaves nothing behind must not linger for the settle window.
func TestApplyPostInstallDetectionOrdinaryPathStaysSingleShot(t *testing.T) {
	prevWindow := detectionSettleWindow
	detectionSettleWindow = 10 * time.Second
	defer func() { detectionSettleWindow = prevWindow }()

	rules := []DetectionRule{{Type: "file_exists", Path: filepath.Join(t.TempDir(), "absent.txt")}}
	start := time.Now()
	r := applyPostInstallDetectionSettling(map[string]any{"success": true}, 0, "out", rules, 0, false)
	if r.Status != "failed" {
		t.Fatalf("want failed, got %q", r.Status)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("ordinary path polled for %v; want a single immediate evaluation", elapsed)
	}
}

// Unsupported-on-this-platform still means "detection not performed" — never a
// silent flip — and must not burn the settle window waiting for a verdict that
// can never change.
func TestApplyPostInstallDetectionSettlingKeepsUnsupportedSemantics(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("registry clause is supported on Windows")
	}
	prevWindow := detectionSettleWindow
	detectionSettleWindow = 10 * time.Second
	defer func() { detectionSettleWindow = prevWindow }()

	payload := map[string]any{"success": true}
	rules := []DetectionRule{{Type: "registry", Path: `SOFTWARE\Acme\App`}}
	start := time.Now()
	r := applyPostInstallDetectionSettling(payload, 0, "out", rules, 0, true)
	if r.Status != "completed" {
		t.Fatalf("want completed, got %q", r.Status)
	}
	if payload["detectionPerformed"] != false {
		t.Fatalf("want detectionPerformed=false, got %v", payload["detectionPerformed"])
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("unsupported detection polled for %v; want an immediate verdict", elapsed)
	}
}
