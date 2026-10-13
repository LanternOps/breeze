package watchdoginstall

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Lock is an exclusive hold on watchdog-install.lock: a process-local claim
// plus an OS file lock (flock / LockFileEx), so neither another goroutine in
// this agent nor another process (an old agent still alive during a
// self-update, or `service install --watchdog`) runs an install or a state
// reset at the same time. Modelled on backup's journal lock. The lock file is
// never removed.
type Lock struct {
	path string
	file *os.File
	once sync.Once
}

var (
	heldLocksMu sync.Mutex
	heldLocks   = map[string]bool{}
)

// AcquireLock takes the lock in dir without blocking. A lock held elsewhere
// returns ErrLockHeld (defer; do not count an attempt).
func AcquireLock(dir string) (*Lock, error) {
	if dir == "" {
		return nil, errNoDir
	}
	p := filepath.Join(dir, LockFileName)

	heldLocksMu.Lock()
	if heldLocks[p] {
		heldLocksMu.Unlock()
		return nil, ErrLockHeld
	}
	heldLocks[p] = true
	heldLocksMu.Unlock()
	unclaim := func() {
		heldLocksMu.Lock()
		delete(heldLocks, p)
		heldLocksMu.Unlock()
	}

	// Refuse (never follow or replace) a lock path that is not a regular file:
	// the directory is root/SYSTEM-only, so a link here is evidence of
	// tampering, not something to repair silently.
	if fi, err := os.Lstat(p); err == nil && !fi.Mode().IsRegular() {
		unclaim()
		return nil, fmt.Errorf("watchdog install lock %s is not a regular file", p)
	}
	f, err := openLockFile(p)
	if err != nil {
		unclaim()
		return nil, fmt.Errorf("open watchdog install lock: %w", err)
	}
	if err := lockFile(f); err != nil {
		_ = f.Close()
		unclaim()
		return nil, ErrLockHeld
	}
	return &Lock{path: p, file: f}, nil
}

// Release drops the lock. Idempotent and nil-safe.
func (l *Lock) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		_ = unlockFile(l.file)
		_ = l.file.Close()
		heldLocksMu.Lock()
		delete(heldLocks, l.path)
		heldLocksMu.Unlock()
	})
}
