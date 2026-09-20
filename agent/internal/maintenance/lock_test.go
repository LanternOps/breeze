package maintenance

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestTryAcquireIsExclusiveAndReleasable(t *testing.T) {
	release, err := TryAcquire("system_cleanup_run")
	if err != nil {
		t.Fatalf("first TryAcquire failed: %v", err)
	}
	if got := CurrentOwner(); got != "system_cleanup_run" {
		t.Fatalf("CurrentOwner() = %q", got)
	}

	if _, err := TryAcquire("brew_cleanup"); !errors.Is(err, ErrBusy) {
		t.Fatalf("second TryAcquire err = %v, want ErrBusy", err)
	}

	release()
	if got := CurrentOwner(); got != "" {
		t.Fatalf("CurrentOwner() after release = %q, want empty", got)
	}
	second, err := TryAcquire("brew_cleanup")
	if err != nil {
		t.Fatalf("TryAcquire after release failed: %v", err)
	}
	second()
}

// Double release must be harmless: every caller uses `defer release()` and
// some also release early on a branch.
func TestReleaseIsIdempotent(t *testing.T) {
	release, err := TryAcquire("a")
	if err != nil {
		t.Fatal(err)
	}
	release()
	release()
	other, err := TryAcquire("b")
	if err != nil {
		t.Fatalf("lock was not free after a double release: %v", err)
	}
	other()
}

// The patch-job path WAITS (its cleanup is best-effort background work);
// the command path does not (a tech is watching a spinner).
func TestAcquireWaitsAndHonoursContextCancellation(t *testing.T) {
	release, err := TryAcquire("holder")
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := Acquire(ctx, "waiter"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Acquire err = %v, want context.DeadlineExceeded", err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		got, err := Acquire(context.Background(), "waiter")
		if err != nil {
			t.Errorf("Acquire after release failed: %v", err)
			return
		}
		got()
	}()
	release()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Acquire did not proceed after the holder released")
	}
}

func TestConcurrentTryAcquireAdmitsExactlyOne(t *testing.T) {
	var wg sync.WaitGroup
	var mu sync.Mutex
	admitted := 0
	releases := make([]func(), 0, 8)

	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := TryAcquire("racer")
			if err != nil {
				return
			}
			mu.Lock()
			admitted++
			releases = append(releases, release)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if admitted != 1 {
		t.Fatalf("%d goroutines acquired the lock, want exactly 1", admitted)
	}
	for _, release := range releases {
		release()
	}
}
