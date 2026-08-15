package tools

import (
	"context"
	"os/exec"
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
	exitCode, output, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "sleep 8 & echo wrapper-done"), "exe")
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

	_, _, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "sleep 10"), "exe")
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout to be labeled as such, got err=%v", err)
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

	exitCode, _, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "exit 3"), "exe")
	if exitCode != 3 {
		t.Fatalf("expected exit code 3, got %d", exitCode)
	}
	if err == nil || !strings.Contains(err.Error(), "installer exited with code 3") {
		t.Fatalf("expected exit-code error, got %v", err)
	}
}
