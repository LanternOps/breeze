package backup

import (
	"os"
	"testing"
)

// TestMain keeps StagingDir-less test managers hermetic. Without this, any
// manager built with no StagingDir resolves its checkpoint-journal dir to the
// REAL ~/.breeze/backup-journal of whoever runs the tests — and cancelled-run
// journals are Abandoned by design, so they accumulate there run after run.
// Individual tests that stub journalHomeDirFn/journalDataDirFn themselves
// (with save/restore) are unaffected: they override and restore back to the
// values set here.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "backup-test-journal-*")
	if err == nil {
		journalHomeDirFn = func() (string, error) { return tmp, nil }
		journalDataDirFn = func() string { return "" }
	}
	code := m.Run()
	if tmp != "" {
		_ = os.RemoveAll(tmp)
	}
	os.Exit(code)
}
