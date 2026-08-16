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

// fakeDMGCommands routes installDMG's child processes through sh so the DMG
// path can be exercised without a real disk image. payload is the entry the
// fake `hdiutil attach` drops in the mount point ("" for an empty image,
// mountFails for a mount that refuses); installScript stands in for the real
// `installer -pkg` / `cp -R` invocation.
const mountFails = "\x00fail"

func fakeDMGCommands(t *testing.T, payload, installScript string) string {
	t.Helper()
	t.Setenv("TMPDIR", t.TempDir())
	mountPoint := filepath.Join(os.TempDir(), "breeze-dmg-mount")

	attachScript := "mkdir -p " + mountPoint
	switch payload {
	case mountFails:
		attachScript = "exit 1"
	case "":
	default:
		attachScript += " && touch " + filepath.Join(mountPoint, payload)
	}

	prev := dmgCommandContext
	dmgCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		switch {
		case name == "hdiutil" && len(args) > 0 && args[0] == "attach":
			return exec.CommandContext(ctx, "sh", "-c", attachScript)
		case name == "hdiutil":
			return exec.CommandContext(ctx, "sh", "-c", "true")
		default:
			return exec.CommandContext(ctx, "sh", "-c", installScript)
		}
	}
	t.Cleanup(func() { dmgCommandContext = prev })
	return mountPoint
}

// The DMG path had its own hand-rolled CombinedOutput call, so a .pkg whose
// postinstall script leaves a descendant behind kept the ORIGINAL bug: Wait
// blocked on pipe EOF until the 30-minute install timeout.
func TestInstallDMGDoesNotBlockOnPkgDescendants(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helpers through sh")
	}
	prev := installerWaitDelay
	installerWaitDelay = 500 * time.Millisecond
	defer func() { installerWaitDelay = prev }()

	fakeDMGCommands(t, "Acme.pkg", "sleep 8 & echo pkg-installed")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	start := time.Now()
	exitCode, output, descendantsPending, err := installDMG(ctx, "/nonexistent/Acme.dmg")
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("expected success after the pkg installer exited, got err=%v (exitCode=%d)", err, exitCode)
	}
	if exitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", exitCode)
	}
	if !strings.Contains(output, "pkg-installed") {
		t.Fatalf("expected captured installer output, got %q", output)
	}
	if elapsed > 4*time.Second {
		t.Fatalf("installDMG blocked on a descendant for %v; want prompt return after the pkg installer exits", elapsed)
	}
	if !descendantsPending {
		t.Fatal("expected descendantsPending=true so post-install detection settles instead of failing an in-flight install")
	}
}

// A genuine DMG install timeout must be labeled as a timeout, not as the kill's
// exit code — the same guarantee runInstallerCommand gives every other type.
func TestInstallDMGLabelsTimeoutAsTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helpers through sh")
	}
	prev := installerWaitDelay
	installerWaitDelay = 300 * time.Millisecond
	defer func() { installerWaitDelay = prev }()

	fakeDMGCommands(t, "Acme.pkg", "sleep 30")

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	_, _, _, err := installDMG(ctx, "/nonexistent/Acme.dmg")
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected a timeout label, got %v", err)
	}
}

// A non-zero pkg installer exit keeps failing the install, and a DMG carrying
// neither payload keeps its own error.
func TestInstallDMGReportsFailures(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helpers through sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	fakeDMGCommands(t, "Acme.pkg", "exit 7")
	exitCode, _, _, err := installDMG(ctx, "/nonexistent/Acme.dmg")
	if exitCode != 7 || err == nil || !strings.Contains(err.Error(), "code 7") {
		t.Fatalf("want exit code 7 surfaced, got exitCode=%d err=%v", exitCode, err)
	}

	fakeDMGCommands(t, "", "true")
	_, _, _, err = installDMG(ctx, "/nonexistent/Acme.dmg")
	if err == nil || !strings.Contains(err.Error(), "no .pkg or .app found in DMG") {
		t.Fatalf("want the DMG-specific empty-image error, got %v", err)
	}
}

// A mount failure stays a mount failure — the hdiutil step must not be reported
// as an installer exit code.
func TestInstallDMGReportsMountFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helpers through sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	fakeDMGCommands(t, mountFails, "true")
	_, _, _, err := installDMG(ctx, "/nonexistent/Acme.dmg")
	if err == nil || !strings.Contains(err.Error(), "failed to mount DMG") {
		t.Fatalf("want a mount-failure error, got %v", err)
	}
}
