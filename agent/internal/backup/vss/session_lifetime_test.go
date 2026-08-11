package vss

import (
	"context"
	"errors"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// goroutineID reads the calling goroutine's ID out of its own stack header, and
// returns 0 if that fails. It must never call t.Fatal: it is invoked from the
// serialThread's goroutine, where the testing package's failure machinery is not
// allowed to run.
//
// It stands in for the property that actually matters — "is this still the same
// OS thread?" — which Go exposes no portable API for. The substitution is sound
// for this type specifically: serialThread's goroutine calls
// runtime.LockOSThread and never unlocks, and a locked goroutine is guaranteed
// by the runtime to run on that one OS thread and to have no other goroutine
// scheduled onto it. So for a permanently locked goroutine, same goroutine means
// same OS thread — and therefore same COM apartment.
func goroutineID() uint64 {
	var buf [64]byte
	n := runtime.Stack(buf[:], false)
	fields := strings.Fields(string(buf[:n]))
	if len(fields) < 2 || fields[0] != "goroutine" {
		return 0
	}
	id, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return id
}

// These tests cover the lifetime machinery behind #3269 with the COM calls out
// of the picture. They are deliberately NOT build-tagged: the machinery is only
// used on Windows, but the properties under test — every call lands on the same
// pinned thread, init/teardown run exactly once and on that thread, a closed
// thread reports rather than deadlocks, and snapshot creation is serialised
// process-wide without ever being serialised for longer than creation — are
// ordinary concurrency, and this is the only way they get run under
// `go test -race` (the Windows CI job runs this package without the race
// detector).

// ---------------------------------------------------------------------------
// serialThread
// ---------------------------------------------------------------------------

// TestSerialThread_RunsEveryCallOnOneLockedThread is the property the whole fix
// rests on: an IVssBackupComponents belongs to the COM apartment of the thread
// that created it, so if two closures ran on different OS threads the interface
// would be called from outside its apartment. See goroutineID for why comparing
// goroutine identity is a sound proxy for thread identity here.
func TestSerialThread_RunsEveryCallOnOneLockedThread(t *testing.T) {
	var initGID uint64
	th, err := newSerialThread(func() error {
		initGID = goroutineID()
		return nil
	}, nil)
	if err != nil {
		t.Fatalf("newSerialThread: %v", err)
	}
	defer th.close()

	// Enough iterations, with scheduling pressure in between, that a goroutine
	// free to migrate would be very unlikely to stay put by accident.
	for i := 0; i < 50; i++ {
		var got uint64
		if err := th.do(func() { got = goroutineID() }); err != nil {
			t.Fatalf("do #%d: %v", i, err)
		}
		if got == 0 || got != initGID {
			t.Fatalf("call #%d ran on goroutine %d, want %d (a migrated call would be outside the COM apartment)", i, got, initGID)
		}
		runtime.Gosched()
	}
}

// TestSerialThread_TeardownRunsOnceOnTheSameThread pins that CoUninitialize's
// stand-in runs on the thread that ran CoInitializeEx's stand-in, and exactly
// once no matter how often close is called. Uninitialising a different thread's
// apartment, or twice, corrupts COM state process-wide.
func TestSerialThread_TeardownRunsOnceOnTheSameThread(t *testing.T) {
	var (
		mu           sync.Mutex
		initGID      uint64
		teardownGID  uint64
		teardownRuns int
	)
	th, err := newSerialThread(
		func() error {
			mu.Lock()
			defer mu.Unlock()
			initGID = goroutineID()
			return nil
		},
		func() {
			mu.Lock()
			defer mu.Unlock()
			teardownGID = goroutineID()
			teardownRuns++
		},
	)
	if err != nil {
		t.Fatalf("newSerialThread: %v", err)
	}

	if err := th.do(func() {}); err != nil {
		t.Fatalf("do: %v", err)
	}

	mu.Lock()
	if teardownRuns != 0 {
		t.Fatalf("teardown ran %d times before close", teardownRuns)
	}
	mu.Unlock()

	th.close()
	th.close() // idempotent
	th.close()

	mu.Lock()
	defer mu.Unlock()
	if teardownRuns != 1 {
		t.Fatalf("teardown ran %d times, want exactly 1", teardownRuns)
	}
	if teardownGID == 0 || teardownGID != initGID {
		t.Fatalf("teardown ran on goroutine %d, init on %d — CoUninitialize must run on the thread that ran CoInitializeEx", teardownGID, initGID)
	}
}

// TestSerialThread_InitFailureStartsNothing covers the CoInitializeEx failure
// path: no thread is left behind, teardown never runs (there is nothing
// initialised to tear down), and the error reaches the caller.
func TestSerialThread_InitFailureStartsNothing(t *testing.T) {
	sentinel := errors.New("init failed")
	teardownRan := false

	th, err := newSerialThread(
		func() error { return sentinel },
		func() { teardownRan = true },
	)
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want %v", err, sentinel)
	}
	if th != nil {
		t.Fatal("newSerialThread returned a thread alongside an error")
	}
	if teardownRan {
		t.Fatal("teardown ran even though init failed — that would CoUninitialize an apartment that was never entered")
	}
}

// TestSerialThread_DoAfterCloseReports is the anti-deadlock property. A release
// path that runs twice, or a stray call after teardown, must get an error back —
// blocking forever on a dead thread would hang the whole backup run.
func TestSerialThread_DoAfterCloseReports(t *testing.T) {
	th, err := newSerialThread(nil, nil)
	if err != nil {
		t.Fatalf("newSerialThread: %v", err)
	}
	th.close()

	done := make(chan error, 1)
	go func() {
		ran := false
		err := th.do(func() { ran = true })
		if ran {
			done <- errors.New("closure ran on a closed thread")
			return
		}
		done <- err
	}()

	select {
	case err := <-done:
		if !errors.Is(err, errSerialThreadClosed) {
			t.Fatalf("do after close = %v, want errSerialThreadClosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("do blocked forever on a closed thread instead of reporting")
	}
}

// TestSerialThread_SerialisesConcurrentCallers checks that closures never
// overlap. COM calls against one IVssBackupComponents are not reentrant, and
// nothing above this layer takes a second lock.
func TestSerialThread_SerialisesConcurrentCallers(t *testing.T) {
	th, err := newSerialThread(nil, nil)
	if err != nil {
		t.Fatalf("newSerialThread: %v", err)
	}
	defer th.close()

	var (
		mu      sync.Mutex
		inside  int
		maxSeen int
		ran     int
	)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = th.do(func() {
				mu.Lock()
				inside++
				if inside > maxSeen {
					maxSeen = inside
				}
				mu.Unlock()

				runtime.Gosched()

				mu.Lock()
				inside--
				ran++
				mu.Unlock()
			})
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if maxSeen != 1 {
		t.Fatalf("observed %d closures running concurrently, want 1", maxSeen)
	}
	if ran != 20 {
		t.Fatalf("%d closures ran, want 20", ran)
	}
}

// ---------------------------------------------------------------------------
// Snapshot-creation gate
// ---------------------------------------------------------------------------

// TestSnapshotCreation_SerialisesButDoesNotBlockForever pins the gate's whole
// point: the second creation waits for the first and then PROCEEDS. It must not
// be rejected, because both runs are entitled to their own shadow copy — VSS
// only serialises the creation interval, not the lifetime of finished snapshot
// sets.
func TestSnapshotCreation_SerialisesButDoesNotBlockForever(t *testing.T) {
	first, err := acquireSnapshotCreation(context.Background())
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if !snapshotCreationBusy() {
		t.Error("gate reports idle while held")
	}

	secondDone := make(chan error, 1)
	go func() {
		release, err := acquireSnapshotCreation(context.Background())
		if release != nil {
			release()
		}
		secondDone <- err
	}()

	// The second acquire must still be waiting while the first is held.
	select {
	case err := <-secondDone:
		t.Fatalf("a second creation was admitted while the first held the gate (err=%v)", err)
	case <-time.After(100 * time.Millisecond):
	}

	first()

	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("the second creation must proceed once the gate frees, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the second creation never acquired the gate after it was released")
	}

	if snapshotCreationBusy() {
		t.Error("gate is still held after both releases")
	}
}

// TestSnapshotCreation_ContextExpiryDegrades covers the bounded-wait contract.
// A run that cannot get in before its creation deadline must come back with
// ErrVSSSessionInProgress so backup.go takes its existing "proceed without VSS"
// path, rather than hanging for the whole of the other run's creation.
func TestSnapshotCreation_ContextExpiryDegrades(t *testing.T) {
	release, err := acquireSnapshotCreation(context.Background())
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer release()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	got, err := acquireSnapshotCreation(ctx)
	if !errors.Is(err, ErrVSSSessionInProgress) {
		t.Fatalf("err = %v, want ErrVSSSessionInProgress", err)
	}
	if got != nil {
		t.Error("a failed acquire must not return a release func")
	}
}

// TestSnapshotCreation_ReleaseIsIdempotent: a double release would free a slot
// the caller no longer owns, letting two runs create snapshot sets at once — the
// exact overlap the gate exists to prevent.
func TestSnapshotCreation_ReleaseIsIdempotent(t *testing.T) {
	release, err := acquireSnapshotCreation(context.Background())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	release()
	release()
	release()

	if snapshotCreationBusy() {
		t.Fatal("gate is held after release")
	}
	// And it is still usable, exactly once.
	second, err := acquireSnapshotCreation(context.Background())
	if err != nil {
		t.Fatalf("re-acquire after idempotent release: %v", err)
	}
	defer second()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := acquireSnapshotCreation(ctx); !errors.Is(err, ErrVSSSessionInProgress) {
		t.Fatalf("the gate stopped excluding after an idempotent release: %v", err)
	}
}

// TestSnapshotCreation_ConcurrentCallersNeverOverlap is the race-detector case.
// Real callers arrive from independent IPC command goroutines, and the property
// that matters is that no two are ever inside the creation interval together.
func TestSnapshotCreation_ConcurrentCallersNeverOverlap(t *testing.T) {
	const racers = 24
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		inside  int
		maxSeen int
		granted int
	)
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			release, err := acquireSnapshotCreation(context.Background())
			if err != nil {
				return
			}
			mu.Lock()
			inside++
			if inside > maxSeen {
				maxSeen = inside
			}
			granted++
			mu.Unlock()

			runtime.Gosched()

			mu.Lock()
			inside--
			mu.Unlock()
			release()
		}()
	}
	close(start)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if maxSeen != 1 {
		t.Fatalf("%d creations were inside the gate at once, want 1", maxSeen)
	}
	// Every one of them must eventually get in: waiting is the design, rejection
	// is not.
	if granted != racers {
		t.Fatalf("%d of %d creations were admitted, want all of them", granted, racers)
	}
	if snapshotCreationBusy() {
		t.Error("gate is still held after every caller released")
	}
}
