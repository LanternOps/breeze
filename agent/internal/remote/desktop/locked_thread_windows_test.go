//go:build windows && !cgo

package desktop

import (
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
)

var procSleepForTest = kernel32.NewProc("Sleep")

// Windows twin of locked_thread_linux_test.go, with the same forcing: every P
// kept busy and a blocking syscall (kernel32 Sleep) in each work item, so an
// unpinned goroutine would be resumed by a different thread.
//
// remote/desktop is excluded from the Test Agent (Windows) CI job (#2523), so
// this runs only on a Windows host:
//
//	CGO_ENABLED=0 go test ./internal/remote/desktop/ -run 'LockedThread|GDICapturer'
func TestLockedThreadPinsOneOSThreadWindows(t *testing.T) {
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
				_ = currentThreadID()
				runtime.Gosched()
			}
		}()
	}
	defer func() { stop.Store(true); load.Wait() }()

	lt := startLockedThread(nil)
	defer lt.Stop()

	var first uint32
	if err := lt.Do(func() { first = currentThreadID() }); err != nil {
		t.Fatal(err)
	}
	if first == 0 {
		t.Fatal("GetCurrentThreadId returned 0")
	}
	for i := 0; i < 100; i++ {
		var before, after uint32
		if err := lt.Do(func() {
			before = currentThreadID()
			procSleepForTest.Call(2)
			after = currentThreadID()
		}); err != nil {
			t.Fatal(err)
		}
		if before != first || after != first {
			t.Fatalf("work %d ran on threads %d/%d, want %d throughout", i, before, after, first)
		}
	}
}
