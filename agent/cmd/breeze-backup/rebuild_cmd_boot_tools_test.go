package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// captureRebuildOptions runs `breeze-backup rebuild` with args (provider-config
// mode, no system-state probe) and returns the options the engine received.
func captureRebuildOptions(t *testing.T, args ...string) rebuild.Options {
	t.Helper()
	dir := t.TempDir()
	provFile := filepath.Join(dir, "prov.json")
	if err := os.WriteFile(provFile, []byte(`{"provider":"local","providerConfig":{"path":"`+filepath.Join(dir, "store")+`"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var got []rebuild.Options
	prev := rebuildRunFn
	rebuildRunFn = func(_ context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		got = append(got, opts)
		return &rebuild.Result{Status: "completed"}, nil
	}
	t.Cleanup(func() { rebuildRunFn = prev })

	cmd := newRebuildCommand()
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(append([]string{"--snapshot", "snap-1", "--target", "disk:/dev/sdb", "--provider-config", provFile,
		"--identity", "new", "--expect-system-state", "false", "--state-dir", dir}, args...))
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute: %v\n%s", err, out.String())
	}
	if len(got) != 1 {
		t.Fatalf("engine calls = %d, want 1", len(got))
	}
	return got[0]
}

func TestRebuildCommand_DefaultRunsNoRestoredBootTools(t *testing.T) {
	opts := captureRebuildOptions(t)
	if opts.RegenerateInitramfs || opts.RestoredBootTools || opts.ConfirmRestoredBootTools {
		t.Fatalf("regenerateInitramfs=%v restoredBootTools=%v confirm=%v, want all false by default",
			opts.RegenerateInitramfs, opts.RestoredBootTools, opts.ConfirmRestoredBootTools)
	}
}

// --no-initramfs stays accepted so existing scripts keep working; it has
// nothing left to turn off by default.
func TestRebuildCommand_NoInitramfsStillAccepted(t *testing.T) {
	opts := captureRebuildOptions(t, "--no-initramfs")
	if opts.RegenerateInitramfs || opts.RestoredBootTools {
		t.Fatalf("opts = %+v", opts)
	}
}

// The opt-in and its confirmation reach the engine unchanged: the engine is
// where they are checked.
func TestRebuildCommand_RestoredBootToolsOptInReachesEngine(t *testing.T) {
	opts := captureRebuildOptions(t, "--restored-boot-tools")
	if !opts.RestoredBootTools || !opts.RegenerateInitramfs || opts.ConfirmRestoredBootTools {
		t.Fatalf("restoredBootTools=%v regenerateInitramfs=%v confirm=%v", opts.RestoredBootTools, opts.RegenerateInitramfs, opts.ConfirmRestoredBootTools)
	}
	opts = captureRebuildOptions(t, "--restored-boot-tools", "--confirm-restored-boot-tools", "--no-initramfs")
	if !opts.RestoredBootTools || opts.RegenerateInitramfs || !opts.ConfirmRestoredBootTools {
		t.Fatalf("restoredBootTools=%v regenerateInitramfs=%v confirm=%v", opts.RestoredBootTools, opts.RegenerateInitramfs, opts.ConfirmRestoredBootTools)
	}
}
