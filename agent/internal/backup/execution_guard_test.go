package backup

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestExecutionGuardAcrossManagers(t *testing.T) {
	ctx, release, err := AcquireExecution(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The helper and its file manager share the same slot through context.
	_, nestedRelease, err := AcquireExecution(ctx)
	if err != nil {
		t.Fatal(err)
	}
	nestedRelease()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := AcquireExecution(cancelled); err != context.Canceled {
		t.Fatalf("cancelled contender: %v", err)
	}
	release()
	_, releaseNext, err := AcquireExecution(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	releaseNext()
}

// Real contention: N goroutines race for the slot and an atomic high-water
// mark proves at most one holds it at any instant.
func TestExecutionGuardSerializesConcurrentContenders(t *testing.T) {
	const contenders = 16
	var active, peak, ran atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, release, err := AcquireExecution(context.Background())
			if err != nil {
				t.Error(err)
				return
			}
			now := active.Add(1)
			for {
				seen := peak.Load()
				if now <= seen || peak.CompareAndSwap(seen, now) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
			active.Add(-1)
			ran.Add(1)
			release()
		}()
	}
	wg.Wait()
	if got := peak.Load(); got != 1 {
		t.Fatalf("peak concurrent holders = %d, want 1", got)
	}
	if got := ran.Load(); got != contenders {
		t.Fatalf("ran %d of %d contenders", got, contenders)
	}
}
