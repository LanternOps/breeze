//go:build linux

package desktop

import (
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// All work runs on one OS thread for the worker's life, whichever goroutine
// submits it.
//
// An unpinned goroutine that is the only thing running tends to stay on one
// thread anyway, so this test only discriminates if the scheduler is forced to
// move it: every P is kept busy, and each work item makes a blocking syscall
// long enough for sysmon to hand its P to another thread. An unpinned
// goroutine then usually comes back from the syscall with no P to run on and
// is resumed by a different thread. Verified to fail with
// runtime.LockOSThread removed from lockedThread.run.
func TestLockedThreadPinsOneOSThread(t *testing.T) {
	prev := runtime.GOMAXPROCS(0)
	if prev < 4 {
		runtime.GOMAXPROCS(4)
		defer runtime.GOMAXPROCS(prev)
	}

	var stop atomic.Bool
	var load sync.WaitGroup
	for i := 0; i < 2*runtime.GOMAXPROCS(0); i++ {
		load.Add(1)
		go func() {
			defer load.Done()
			for !stop.Load() {
				_ = syscall.Getpid()
				runtime.Gosched()
			}
		}()
	}
	defer func() { stop.Store(true); load.Wait() }()

	lt := startLockedThread(nil)
	defer lt.Stop()

	var first int
	if err := lt.Do(func() { first = syscall.Gettid() }); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		var before, after int
		if err := lt.Do(func() {
			before = syscall.Gettid()
			ts := syscall.Timespec{Nsec: int64(2 * time.Millisecond)}
			_ = syscall.Nanosleep(&ts, nil)
			after = syscall.Gettid()
		}); err != nil {
			t.Fatal(err)
		}
		if before != first || after != first {
			t.Fatalf("work %d ran on threads %d/%d, want %d throughout", i, before, after, first)
		}
	}
}
