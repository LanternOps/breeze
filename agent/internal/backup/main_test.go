package backup

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// TestMain keeps StagingDir-less test managers hermetic. Without this, any
// manager built with no StagingDir resolves its checkpoint-journal dir to the
// REAL ~/.breeze/backup-journal of whoever runs the tests — and cancelled-run
// journals are Abandoned by design, so they accumulate there run after run.
// Individual tests that stub journalHomeDirFn/journalDataDirFn themselves
// (with save/restore) are unaffected: they override and restore back to the
// values set here.
//
// collectLayout also gets a hermetic default here (W01): left at its real
// layout.Collect implementation, any SystemStateEnabled:true test on a real
// Linux host shells out to lsblk and picks up whatever disk topology the
// TEST RUNNER happens to have — bare-metal-restorable on a real VM,
// "no disk holds the root filesystem" inside a container with no matching
// block device. A pre-existing test asserting "healthy run produces no
// warning" then flakes on environment, not on anything this package does.
// Defaulting to ErrUnsupportedPlatform mirrors backup.go's own "this host
// has no collector" handling (silently skipped, no warning, nil
// LayoutManifest/BareMetal) — the same hermetic no-op darwin already gets
// for free. Tests that care about layout collection use stubCollectLayout
// (save/restore), same convention as journalHomeDirFn/journalDataDirFn.
//
// collectSystemState gets the same treatment (#11201): the real collector
// copies the runner's whole /etc, 854 MB on the CI image and more than the
// package's 10-minute timeout allows when its disk is slow. A test that wants
// system state stubs it (stubCollectSystemState); one that forgets gets a
// "not collected" warning instead of a poisoned merge queue.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "backup-test-journal-*")
	if err == nil {
		journalHomeDirFn = func() (string, error) { return tmp, nil }
		journalDataDirFn = func() string { return "" }
	}
	collectLayout = func(context.Context) (*layout.Manifest, error) {
		return nil, layout.ErrUnsupportedPlatform
	}
	collectSystemState = func(context.Context, systemstate.CollectOptions) (*systemstate.SystemStateManifest, string, error) {
		return nil, "", errors.New("the real system-state collector is off in tests: use stubCollectSystemState")
	}
	code := m.Run()
	if tmp != "" {
		_ = os.RemoveAll(tmp)
	}
	os.Exit(code)
}
