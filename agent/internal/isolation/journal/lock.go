package journal

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ErrLocked: another holder (the agent, the recovery binary, or another
// goroutine) holds the machine-wide isolation lock.
var ErrLocked = errors.New("isolation lock is held by another process")

// lockWait bounds how long Lock waits for the lock. A holder never keeps it
// across network probes, so a long wait means a stuck holder; the caller
// reports isolation_busy and retries rather than blocking forever.
var lockWait = 30 * time.Second

const lockPoll = 20 * time.Millisecond

// Lock takes the machine-wide lock at <dir>/isolation.lock, waiting up to
// lockWait. It is flock on Unix and LockFileEx on Windows, exclusive and per
// open file, so two holders in one process also exclude each other. The
// returned unlock func is idempotent.
func Lock(dir string) (func(), error) {
	deadline := time.Now().Add(lockWait)
	for {
		unlock, err := TryLock(dir)
		if err == nil || !errors.Is(err, ErrLocked) {
			return unlock, err
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(lockPoll)
	}
}

// TryLock takes the lock or fails at once with ErrLocked.
func TryLock(dir string) (func(), error) {
	path := filepath.Join(dir, LockName)
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open isolation lock: %w", err)
	}
	if err := lockFile(f); err != nil {
		_ = f.Close()
		if isLockContention(err) {
			return nil, fmt.Errorf("%w: %s", ErrLocked, path)
		}
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = unlockFile(f)
			_ = f.Close()
		})
	}, nil
}
