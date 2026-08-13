package vss

import (
	"context"
	"errors"
	"runtime"
	"sync"
)

// This file holds the two pieces of #3269's lifetime fix that are pure Go: the
// pinned worker thread the COM calls are routed onto, and the process-wide gate
// that serialises snapshot *creation*.
//
// Neither has a build tag, and that is deliberate. The COM calls they carry are
// unfakeable and Windows-only, but the machinery around them — start a thread,
// keep every call on it, release exactly once, don't let two runs create a
// snapshot set at the same moment — is ordinary concurrent Go, and it is where a
// mistake costs a customer their backup. Keeping it platform-neutral puts it
// under `go test -race` on every developer machine and in the linux CI job,
// instead of only in the Windows job, which runs this package without the race
// detector.

// ---------------------------------------------------------------------------
// serialThread
// ---------------------------------------------------------------------------

// errSerialThreadClosed is returned by serialThread.do once the thread has
// stopped accepting work.
var errSerialThreadClosed = errors.New("vss: session thread is closed")

// serialThread owns one OS thread and runs submitted closures on it, one at a
// time.
//
// It exists to give the COM work a stable home. A VSS_CTX_BACKUP shadow copy is
// an *auto-release* copy: Windows deletes it once the requester drops its
// references to the IVssBackupComponents that created it. Holding that object
// for the whole backup run means holding a thread that has COM initialised for
// the whole run, and the Go scheduler may move a goroutine to a different OS
// thread between any two statements — so the thread has to be pinned and every
// call routed back onto it.
//
// The thread is locked for its entire life and is deliberately NEVER unlocked.
// A goroutine that exits while still locked makes the Go runtime destroy the
// underlying OS thread, so no unrelated goroutine can inherit a thread carrying
// our COM state. Note what that does and does not do: an MTA is process-wide,
// not a private apartment this thread owns, so destroying the thread does not
// tear down the MTA, and it is emphatically NOT the mechanism that reclaims the
// shadow copy. Releasing the IVssBackupComponents is.
//
// Two limits worth knowing. Concurrent callers are serialised but not ordered:
// nothing here promises FIFO among goroutines racing to submit. And a COM call
// that wedges inside a vtable dispatch cannot be preempted by anything —
// context, close, or otherwise — because it is a synchronous foreign call on
// this thread; only the polling *between* COM calls is context-bounded.
type serialThread struct {
	calls    chan func()
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

// newSerialThread starts the thread and runs init on it before accepting any
// work. If init returns an error the thread exits without running teardown —
// there is nothing initialised to tear down — and the error is returned here.
// That distinction is load-bearing for COM: CoInitializeEx returning S_FALSE is
// a success that still owes a CoUninitialize, while a genuine failure such as
// RPC_E_CHANGED_MODE must never be uninitialized.
//
// teardown runs on the same thread after the last submitted closure has
// finished, immediately before the thread exits.
func newSerialThread(init func() error, teardown func()) (*serialThread, error) {
	t := &serialThread{
		calls: make(chan func()),
		stop:  make(chan struct{}),
		done:  make(chan struct{}),
	}
	ready := make(chan error, 1)

	go func() {
		// Never unlocked; see the type comment. This is the single most
		// load-bearing line in the file.
		runtime.LockOSThread()
		defer close(t.done)

		if init != nil {
			if err := init(); err != nil {
				ready <- err
				return
			}
		}
		if teardown != nil {
			defer teardown()
		}
		ready <- nil

		for {
			// Shutdown wins over pending work. Without this the select below
			// would pick nondeterministically between a ready call and a closed
			// stop channel, so close() could still admit one more closure.
			select {
			case <-t.stop:
				return
			default:
			}
			select {
			case fn := <-t.calls:
				fn()
			case <-t.stop:
				return
			}
		}
	}()

	if err := <-ready; err != nil {
		// Wait for the goroutine to actually finish, so a failed start never
		// leaves a thread behind that a later close() would have to reap.
		<-t.done
		return nil, err
	}
	return t, nil
}

// do runs fn on the thread and blocks until fn returns. Anything fn writes to
// variables captured from the caller is visible to the caller once do returns:
// the channel send and the completion signal are the happens-before edges.
//
// It reports errSerialThreadClosed if the thread is already stopping, rather
// than blocking forever — a call after teardown is a caller bug, and the one
// thing it must not do is deadlock the backup run.
func (t *serialThread) do(fn func()) error {
	// Checked first so a call submitted after close() has begun is refused
	// rather than racing the worker's own select.
	select {
	case <-t.stop:
		return errSerialThreadClosed
	default:
	}

	finished := make(chan struct{})
	select {
	case t.calls <- func() { defer close(finished); fn() }:
	case <-t.done:
		return errSerialThreadClosed
	}
	select {
	case <-finished:
		return nil
	case <-t.done:
		return errSerialThreadClosed
	}
}

// close runs teardown on the thread, waits for it to exit, and is idempotent.
func (t *serialThread) close() {
	t.stopOnce.Do(func() { close(t.stop) })
	<-t.done
}

// ---------------------------------------------------------------------------
// Snapshot-creation gate
// ---------------------------------------------------------------------------

// snapshotCreationGate serialises snapshot *creation* across the process.
//
// The scope is deliberate, and it is narrower than "one backup at a time". What
// VSS actually serialises is the creation interval — from StartSnapshotSet until
// DoSnapshotSet completes — which is why a second requester inside that window
// gets VSS_E_SNAPSHOT_SET_IN_PROGRESS. It does not require that only one
// finished snapshot set be alive at a time, and writers are built to tell
// concurrent backup sessions apart. So two overlapping backup runs may both end
// up holding their own live shadow copies; only their creation is queued.
//
// Gating the whole session instead would have been a behaviour regression
// dressed as safety: nu-backup dispatches every IPC command in its own
// goroutine and builds an ephemeral BackupManager per server-dispatched
// backup_run, so overlapping runs are routine, and a session-wide gate would
// silently downgrade one of them to a live read for the entire duration of the
// other. It would also mean a single forgotten ReleaseShadowCopy disabled VSS on
// that machine until the helper restarted. Neither cost buys anything: the
// exclusion VSS needs is already over by the time DoSnapshotSet returns.
//
// Waiting rather than failing fast is right at this scope. Creation is normally
// seconds, it is already bounded by the caller's creation context, and
// Microsoft's documented response to VSS_E_SNAPSHOT_SET_IN_PROGRESS is to wait
// and retry. A wait that outlives the context degrades to
// ErrVSSSessionInProgress and the caller's existing no-VSS path.
//
// Note it cannot serialise against a *different* process acting as requester, so
// VSS_E_SNAPSHOT_SET_IN_PROGRESS still has to be survivable on its own.
var snapshotCreationGate = make(chan struct{}, 1)

// acquireSnapshotCreation claims the creation gate, giving up if ctx ends first.
// The returned release func is nil when the error is non-nil.
func acquireSnapshotCreation(ctx context.Context) (release func(), err error) {
	select {
	case snapshotCreationGate <- struct{}{}:
		var once sync.Once
		return func() { once.Do(func() { <-snapshotCreationGate }) }, nil
	case <-ctx.Done():
		return nil, ErrVSSSessionInProgress
	}
}

// snapshotCreationBusy reports whether the gate is currently held. For tests and
// diagnostics only — never branch production behaviour on it, since the answer
// is stale the moment it is returned.
func snapshotCreationBusy() bool {
	return len(snapshotCreationGate) > 0
}
