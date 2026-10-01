package backup

import (
	"errors"
	"fmt"
	"os"
	"sync"
)

// journalLockSuffix names the lock file beside a checkpoint journal. The
// journal itself is truncated, replaced and removed during a run, so the
// lock lives in a separate, never-removed file.
const journalLockSuffix = ".lock"

// errJournalBusy reports that another run holds the checkpoint journal; the
// caller proceeds without one.
var errJournalBusy = errors.New("backup journal is in use by another run")

var (
	heldJournalsMu sync.Mutex
	heldJournals   = map[string]bool{}
)

// journalLock is one run's exclusive hold on a journal path: a
// process-local claim plus an operating-system lock on the lock file, so
// neither another run in this helper nor another process can open the same
// journal at the same time.
type journalLock struct {
	path string
	file *os.File
	once sync.Once
}

func acquireJournalLock(journalPath string) (*journalLock, error) {
	heldJournalsMu.Lock()
	if heldJournals[journalPath] {
		heldJournalsMu.Unlock()
		return nil, errJournalBusy
	}
	heldJournals[journalPath] = true
	heldJournalsMu.Unlock()
	release := func() {
		heldJournalsMu.Lock()
		delete(heldJournals, journalPath)
		heldJournalsMu.Unlock()
	}

	lockPath := journalPath + journalLockSuffix
	if fi, err := os.Lstat(lockPath); err == nil && !fi.Mode().IsRegular() {
		if rmErr := os.Remove(lockPath); rmErr != nil {
			release()
			return nil, fmt.Errorf("failed to remove non-regular backup journal lock: %w", rmErr)
		}
	}
	f, err := os.OpenFile(lockPath, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		release()
		return nil, fmt.Errorf("failed to open backup journal lock: %w", err)
	}
	if err := lockJournalFile(f); err != nil {
		_ = f.Close()
		release()
		return nil, errJournalBusy
	}
	return &journalLock{path: journalPath, file: f}, nil
}

// release drops the hold. Idempotent and nil-safe.
func (l *journalLock) release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		_ = unlockJournalFile(l.file)
		_ = l.file.Close()
		heldJournalsMu.Lock()
		delete(heldJournals, l.path)
		heldJournalsMu.Unlock()
	})
}
