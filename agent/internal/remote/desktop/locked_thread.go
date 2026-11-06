package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"runtime/debug"
	"sync"
)

// lockedThread runs submitted work on one dedicated, locked OS thread.
//
// It exists for the GDI capturer (#8434, #9558). On Windows, the thread's
// desktop (SetThreadDesktop), the display DC and the DIB section have to agree:
// a DC used from a thread attached to a different desktop than the input
// desktop fails BitBlt with ERROR_INVALID_HANDLE, and SetThreadDesktop refuses
// a thread that owns windows or hooks. Before this, capture ran on whichever
// goroutine called Capture — the startup probe's, then the streaming loop's —
// each pinned and attached separately, with the capturer's handles rebuilt on
// every hand-over and the attach failing on threads that had picked up GUI
// state. Owning the thread makes the attachment a property of the capturer.
//
// No build tag: nothing here is Windows-specific, and the lifecycle contract is
// asserted on the Linux runner (locked_thread_test.go).
//
// The goroutine never calls runtime.UnlockOSThread. When a goroutine exits
// while locked, the Go runtime terminates its OS thread instead of returning it
// to the scheduler, so a thread that was moved onto the Winlogon desktop, or
// that turned out to own windows, never runs other goroutines afterwards.
type lockedThread struct {
	work     chan lockedThreadWork
	quit     chan struct{}
	exited   chan struct{}
	stopOnce sync.Once
}

type lockedThreadWork struct {
	fn   func()
	done chan error
}

// errLockedThreadStopped is returned by Do once the thread has been stopped.
var errLockedThreadStopped = errors.New("capture thread has stopped")

// startLockedThread starts the thread. onExit, if non-nil, runs on the thread
// itself after the last work item and before Stop returns.
func startLockedThread(onExit func()) *lockedThread {
	t := &lockedThread{
		work:   make(chan lockedThreadWork),
		quit:   make(chan struct{}),
		exited: make(chan struct{}),
	}
	ready := make(chan struct{})
	go t.run(onExit, ready)
	<-ready
	return t
}

func (t *lockedThread) run(onExit func(), ready chan<- struct{}) {
	runtime.LockOSThread() // never unlocked; see the type comment
	defer close(t.exited)
	close(ready)
	for {
		select {
		case w := <-t.work:
			w.done <- runLockedThreadWork(w.fn)
		case <-t.quit:
			if onExit != nil {
				if err := runLockedThreadWork(onExit); err != nil {
					// Nothing is waiting for this result, and onExit is where
					// handles are released, so a failure here means a leak.
					slog.Error("capture thread cleanup failed", "error", err.Error())
				}
			}
			return
		}
	}
}

// runLockedThreadWork runs fn and turns a panic into an error, so one bad
// work item does not leave every later caller blocked on a dead thread.
func runLockedThreadWork(fn func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic on capture thread: %v", r)
			slog.Error("panic on capture thread", "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
		}
	}()
	fn()
	return nil
}

// Do runs fn on the locked thread and waits for it to finish.
func (t *lockedThread) Do(fn func()) error {
	w := lockedThreadWork{fn: fn, done: make(chan error, 1)}
	select {
	case <-t.quit:
		return errLockedThreadStopped
	default:
	}
	select {
	case t.work <- w:
		return <-w.done
	case <-t.exited:
		return errLockedThreadStopped
	}
}

// Stop runs onExit on the thread, lets the thread exit, and waits for both.
// Safe to call more than once and after stopAsync.
func (t *lockedThread) Stop() {
	t.stopAsync()
	<-t.exited
}

// stopAsync signals the thread to stop without waiting. It is the path for a
// GC cleanup, which must not block.
func (t *lockedThread) stopAsync() {
	t.stopOnce.Do(func() { close(t.quit) })
}
