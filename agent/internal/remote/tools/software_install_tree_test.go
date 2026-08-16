package tools

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A genuine install timeout must terminate the whole process tree. Installers
// are wrappers: killing only the direct child leaves the REAL setup running as
// an orphan, still mutating the device long after the deployment was reported
// as timed out.
func TestRunInstallerCommandKillsProcessTreeOnTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helper through sh")
	}
	prev := installerWaitDelay
	installerWaitDelay = 500 * time.Millisecond
	defer func() { installerWaitDelay = prev }()

	marker := filepath.Join(t.TempDir(), "descendant-ran.txt")
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	// The wrapper hangs past the deadline while a descendant keeps working; the
	// descendant writes its marker only after the wrapper has been killed.
	script := "( sleep 2; echo alive > " + marker + " ) & sleep 30"
	_, _, _, err := runInstallerCommand(ctx, shInstallerCommand(ctx, script), "exe")
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout error, got %v", err)
	}

	time.Sleep(3 * time.Second)
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatal("descendant survived the install timeout and kept running; want the whole process tree terminated")
	}
}

// The tree kill belongs to the genuine-timeout path ONLY. A wrapper that exits
// successfully while the real installer keeps running is the normal case the
// WaitDelay fix exists to serve — killing there would abort every healthy
// wrapper-style install the moment the wrapper returned.
func TestRunInstallerCommandLeavesDescendantsAloneOnSuccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helper through sh")
	}
	prev := installerWaitDelay
	installerWaitDelay = 300 * time.Millisecond
	defer func() { installerWaitDelay = prev }()

	marker := filepath.Join(t.TempDir(), "install-landed.txt")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	script := "( sleep 1; echo alive > " + marker + " ) & echo wrapper-done"
	_, _, descendantsPending, err := runInstallerCommand(ctx, shInstallerCommand(ctx, script), "exe")
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if !descendantsPending {
		t.Fatal("expected descendantsPending=true")
	}

	time.Sleep(2 * time.Second)
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Fatalf("descendant install was killed after the wrapper exited successfully: %v", statErr)
	}
}
