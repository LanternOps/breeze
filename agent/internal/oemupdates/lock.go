package oemupdates

import (
	"errors"
	"sync"
)

// ErrRunInFlight is returned when a run already holds the lock.
var ErrRunInFlight = errors.New("a vendor update run is already in progress")

var (
	runLocksMu sync.Mutex
	runLocks   = map[string]bool{}
)

// AcquireRunLock takes the per-device run lock, so duplicate deliveries of a
// command, or two commands, cannot run vendor tools at once.
//
// The lock is in-process on purpose. Only the agent runs vendor tools (the
// watchdog does not), so the one process is the whole contention domain, and a
// lock file would survive a crash and refuse every later run. A run that dies
// with the process is found through the marker instead.
func AcquireRunLock(store Store) (release func(), err error) {
	key := store.Key()
	runLocksMu.Lock()
	defer runLocksMu.Unlock()
	if runLocks[key] {
		return nil, ErrRunInFlight
	}
	runLocks[key] = true
	var once sync.Once
	return func() {
		once.Do(func() {
			runLocksMu.Lock()
			delete(runLocks, key)
			runLocksMu.Unlock()
		})
	}, nil
}
