//go:build windows

package desktop

import (
	"runtime"
	"sync"
)

// inputThread is a single OS-thread-locked goroutine that serializes every
// user32 input syscall (BlockInput, SendInput, SetCursorPos, desktop switch,
// metrics, ...). See input_thread.go for the full rationale.
type inputThread struct {
	queue chan func()
}

var (
	inputThreadOnce     sync.Once
	inputThreadInstance *inputThread
)

// getInputThread lazily starts the package-level input serializer thread.
func getInputThread() *inputThread {
	inputThreadOnce.Do(func() {
		t := &inputThread{
			// A small buffer keeps the common case (one operation in flight)
			// allocation-free without letting work pile up unbounded.
			queue: make(chan func(), 64),
		}
		started := make(chan struct{})
		go t.run(started)
		<-started
		inputThreadInstance = t
	})
	return inputThreadInstance
}

// run pins itself to a single OS thread for the process lifetime and executes
// submitted closures one at a time, in submission order. It never unlocks the
// thread: the BlockInput affinity guarantee requires that the SAME thread owns
// the block, the injection, and the release, so the thread must persist.
func (t *inputThread) run(started chan struct{}) {
	runtime.LockOSThread()
	// Intentionally no UnlockOSThread / no return: this goroutine owns its OS
	// thread forever so the thread identity is stable across block/inject/release.
	close(started)
	for fn := range t.queue {
		fn()
	}
}

// submit runs fn on the input thread and blocks until it has completed. It is
// the single serialization point for all Windows input syscalls.
func (t *inputThread) submit(fn func()) {
	done := make(chan struct{})
	t.queue <- func() {
		defer close(done)
		fn()
	}
	<-done
}

// runOnInputThread executes fn on the dedicated, OS-thread-locked input
// serializer and waits for it to finish. All user32 input syscalls on Windows
// MUST go through this so BlockInput/SendInput/BlockInput-release share one
// thread.
func runOnInputThread(fn func()) {
	getInputThread().submit(fn)
}
