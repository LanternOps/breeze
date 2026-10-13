package heartbeat

import (
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// A staged binary whose folder ACL fails verification must never reach the
// privileged `service install` exec (swap-between-checksum-and-exec window).
func TestReconcile_StagedFolderVerifyFailureBlocksRegister(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	var verified string
	h.watchdogEnsure.verifyStaged = func(p string) error {
		verified = p
		return errors.New("data dir grants write to Users")
	}
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if verified == "" {
		t.Fatal("verifyStaged was not consulted")
	}
	if f.registers.Load() != 0 {
		t.Fatalf("register ran despite a failed staged-folder verification (registers=%d)", f.registers.Load())
	}
	rec := loadRec(t, dir)
	if rec.LastClass != watchdoginstall.ClassInstallCmd {
		t.Fatalf("LastClass = %q, want %q", rec.LastClass, watchdoginstall.ClassInstallCmd)
	}
}
