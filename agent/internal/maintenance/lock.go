// Package maintenance holds the agent's single process-wide lock for
// long-running OS maintenance (Disk Cleanup v2, spec §13 #4/#12).
//
// It exists because the operations it guards are not merely slow, they
// interfere:
//
//   - Windows Disk Cleanup is driven by a SHARED registry profile
//     (StateFlags5555). Two concurrent runs both rewrite it before invoking
//     `cleanmgr /sagerun:5555`, and whichever wrote last decides what BOTH
//     runs execute — a tech who selected "Setup Log Files" can silently get
//     "Previous Installations" because another session started a run a second
//     earlier.
//   - DISM refuses to service the same image twice and returns an unhelpful
//     error, so the second run looks like a failure rather than a conflict.
//   - Homebrew does not guarantee that `brew cleanup --prune=all` is safe
//     concurrently with another cleanup or with an in-flight upgrade.
//
// A LEAF package with no internal imports: both internal/syscleanup and
// internal/patching depend on it, so any import back into either would be a
// cycle.
package maintenance

import (
	"context"
	"errors"
	"sync"
)

// ErrBusy is returned by TryAcquire when another operation holds the lock.
// Callers surface it as a `busy` action status rather than a failure: nothing
// was attempted, and a retry is the right next step.
var ErrBusy = errors.New("another maintenance operation is already running")

var (
	mu     sync.Mutex
	locked bool
	owner  string
	// waiters is signalled on every release so Acquire can re-check without
	// polling. A condition variable rather than a channel because the lock is
	// held by a plain bool under `mu` and Cond is the shape that fits.
	waiters = sync.NewCond(&mu)
)

// TryAcquire takes the lock or fails immediately with ErrBusy.
//
// The command path uses this: a tech is watching a spinner, and "something
// else is running maintenance, try again shortly" is a better answer than an
// unbounded wait inside a two-hour command budget.
//
// The returned release is idempotent — callers `defer release()` and some also
// release early on a branch.
func TryAcquire(ownerName string) (func(), error) {
	mu.Lock()
	defer mu.Unlock()
	if locked {
		return nil, ErrBusy
	}
	locked = true
	owner = ownerName
	return releaser(), nil
}

// Acquire waits for the lock, or for ctx to be done.
//
// The patch-job Homebrew cleanup uses this: it is debounced background work
// with no user waiting on it, so queueing behind a cleanup run is strictly
// better than skipping the cleanup entirely.
func Acquire(ctx context.Context, ownerName string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Wake the Cond when ctx is done so a waiter cannot block past its
	// deadline; the re-check below then observes ctx.Err().
	stop := context.AfterFunc(ctx, func() {
		mu.Lock()
		waiters.Broadcast()
		mu.Unlock()
	})
	defer stop()

	mu.Lock()
	defer mu.Unlock()
	for locked {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		waiters.Wait()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	locked = true
	owner = ownerName
	return releaser(), nil
}

// CurrentOwner names the holder, or "" when the lock is free. For log lines
// and the `busy` status's reason string — never for control flow, since it is
// stale the instant it returns.
func CurrentOwner() string {
	mu.Lock()
	defer mu.Unlock()
	return owner
}

func releaser() func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			mu.Lock()
			locked = false
			owner = ""
			waiters.Broadcast()
			mu.Unlock()
		})
	}
}
