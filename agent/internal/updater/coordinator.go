package updater

import (
	"errors"
	"sync"
	"sync/atomic"
)

var processMutationActive atomic.Bool

var ErrProcessMutationInProgress = errors.New("another agent component mutation is in progress")

// ProcessMutationLease serializes every in-process agent-owned binary mutation.
// It deliberately does not block: callers either retain their pending work for
// a later tick or fail a rollback closed instead of accumulating goroutines.
type ProcessMutationLease struct {
	release sync.Once
}

func TryBeginProcessMutation(_ string) (*ProcessMutationLease, bool) {
	if !processMutationActive.CompareAndSwap(false, true) {
		return nil, false
	}
	return &ProcessMutationLease{}, true
}

func (l *ProcessMutationLease) Release() {
	if l == nil {
		return
	}
	l.release.Do(func() { processMutationActive.Store(false) })
}
