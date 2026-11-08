package desktop

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// No build tag. lockedThread is what keeps the GDI capturer's desktop
// attachment, display DC and DIB section on one OS thread for the capturer's
// whole life (#8434). Thread identity itself is asserted per platform in
// locked_thread_{linux,windows}_test.go; these cover the lifecycle contract.

func TestLockedThreadRunsWorkInOrder(t *testing.T) {
	lt := startLockedThread(nil)
	defer lt.Stop()

	var got []int
	for i := 0; i < 50; i++ {
		i := i
		if err := lt.Do(func() { got = append(got, i) }); err != nil {
			t.Fatalf("Do(%d): %v", i, err)
		}
	}
	for i, v := range got {
		if v != i {
			t.Fatalf("work ran out of order: %v", got)
		}
	}
}

// Do is synchronous: when it returns, the work has finished and its writes are
// visible to the caller without further synchronisation.
func TestLockedThreadDoIsSynchronous(t *testing.T) {
	lt := startLockedThread(nil)
	defer lt.Stop()

	var v int
	if err := lt.Do(func() { time.Sleep(10 * time.Millisecond); v = 42 }); err != nil {
		t.Fatal(err)
	}
	if v != 42 {
		t.Fatalf("Do returned before the work finished: v = %d", v)
	}
}

// Callers from many goroutines are serialised onto the one thread.
func TestLockedThreadSerialisesConcurrentCallers(t *testing.T) {
	lt := startLockedThread(nil)
	defer lt.Stop()

	var inFlight, maxInFlight atomic.Int32
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				_ = lt.Do(func() {
					n := inFlight.Add(1)
					for {
						m := maxInFlight.Load()
						if n <= m || maxInFlight.CompareAndSwap(m, n) {
							break
						}
					}
					inFlight.Add(-1)
				})
			}
		}()
	}
	wg.Wait()
	if m := maxInFlight.Load(); m != 1 {
		t.Fatalf("work overlapped on the locked thread: max in flight = %d", m)
	}
}

// onExit runs exactly once, on the locked thread, before Stop returns — that
// is where the GDI capturer releases its DC, DIB section and desktop handle.
func TestLockedThreadStopRunsOnExitOnce(t *testing.T) {
	var calls atomic.Int32
	lt := startLockedThread(func() { calls.Add(1) })
	lt.Stop()
	if calls.Load() != 1 {
		t.Fatalf("onExit ran %d times before Stop returned, want 1", calls.Load())
	}
	lt.Stop() // idempotent
	lt.stopAsync()
	if calls.Load() != 1 {
		t.Fatalf("onExit ran %d times after repeated stops, want 1", calls.Load())
	}
}

func TestLockedThreadDoAfterStopFails(t *testing.T) {
	lt := startLockedThread(nil)
	lt.Stop()
	ran := false
	err := lt.Do(func() { ran = true })
	if !errors.Is(err, errLockedThreadStopped) {
		t.Fatalf("Do after Stop = %v, want errLockedThreadStopped", err)
	}
	if ran {
		t.Fatal("work ran after Stop")
	}
}

// stopAsync is the GC safety net's path: it must not block, and the thread
// must still exit (and run onExit) afterwards.
func TestLockedThreadStopAsyncDoesNotBlock(t *testing.T) {
	exited := make(chan struct{})
	lt := startLockedThread(func() { close(exited) })
	done := make(chan struct{})
	go func() { lt.stopAsync(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stopAsync blocked")
	}
	select {
	case <-exited:
	case <-time.After(2 * time.Second):
		t.Fatal("thread did not exit after stopAsync")
	}
}

// A panic in submitted work must not wedge callers: Do reports it and the
// thread keeps serving.
func TestLockedThreadRecoversFromPanickingWork(t *testing.T) {
	lt := startLockedThread(nil)
	defer lt.Stop()
	if err := lt.Do(func() { panic("boom") }); err == nil {
		t.Fatal("a panicking work item must be reported as an error")
	}
	ok := false
	if err := lt.Do(func() { ok = true }); err != nil || !ok {
		t.Fatalf("thread stopped serving after a panic: err=%v ran=%v", err, ok)
	}
}
