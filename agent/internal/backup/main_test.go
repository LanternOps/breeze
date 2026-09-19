package backup

import (
	"context"
	"os"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
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
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "backup-test-journal-*")
	if err == nil {
		journalHomeDirFn = func() (string, error) { return tmp, nil }
		journalDataDirFn = func() string { return "" }
	}
	collectLayout = func(context.Context) (*layout.Manifest, error) {
		return nil, layout.ErrUnsupportedPlatform
	}
	code := m.Run()
	if tmp != "" {
		_ = os.RemoveAll(tmp)
	}
	os.Exit(code)
}
