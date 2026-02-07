package workerpool

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestSubmitAndDrain(t *testing.T) {
	p := New(2, 10)
	var count atomic.Int32

	for i := 0; i < 5; i++ {
		ok := p.Submit(func() {
			count.Add(1)
		})
		if !ok {
			t.Fatalf("Submit %d failed", i)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p.Shutdown(ctx)

	if got := count.Load(); got != 5 {
		t.Fatalf("count = %d, want 5", got)
	}
}

func TestSubmitAfterShutdownReturnsFalse(t *testing.T) {
	p := New(1, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p.Shutdown(ctx)

	if p.Submit(func() {}) {
		t.Fatal("Submit after Shutdown should return false")
	}
}

func TestQueueFullReturnsFalse(t *testing.T) {
	p := New(1, 1)
	// Block the worker
	blocker := make(chan struct{})
	p.Submit(func() { <-blocker })

	// Fill the queue
	time.Sleep(10 * time.Millisecond) // let worker pick up first task
	p.Submit(func() {})               // fills the queue (size 1)

	// This should fail — queue full
	if p.Submit(func() {}) {
		t.Fatal("Submit should return false when queue is full")
	}

	close(blocker)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p.Shutdown(ctx)
}

func TestDrainWithoutStopAcceptingAutoStops(t *testing.T) {
	p := New(1, 10)
	p.Submit(func() {})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Call Drain directly without StopAccepting — should auto-stop
	p.Drain(ctx)

	if p.Submit(func() {}) {
		t.Fatal("Submit should return false after auto-stopped Drain")
	}
}

func TestContextCancelledAfterDrain(t *testing.T) {
	p := New(1, 10)
	p.Submit(func() {})

	poolCtx := p.Context()
	if poolCtx.Err() != nil {
		t.Fatal("pool context should not be cancelled before Drain")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p.Shutdown(ctx)

	if poolCtx.Err() == nil {
		t.Fatal("pool context should be cancelled after Drain")
	}
}

func TestDrainRespectsContextDeadline(t *testing.T) {
	p := New(1, 10)
	blocker := make(chan struct{})
	p.Submit(func() { <-blocker })

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	p.Shutdown(ctx)
	elapsed := time.Since(start)

	if elapsed > 500*time.Millisecond {
		t.Fatalf("Drain should have timed out in ~100ms, took %v", elapsed)
	}

	close(blocker) // cleanup
}

func TestSingleWorkerDrainDoesNotDeadlock(t *testing.T) {
	p := New(1, 10)
	var count atomic.Int32

	for i := 0; i < 5; i++ {
		p.Submit(func() {
			time.Sleep(1 * time.Millisecond)
			count.Add(1)
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p.Shutdown(ctx)

	if got := count.Load(); got != 5 {
		t.Fatalf("single-worker drain: count = %d, want 5", got)
	}
}

func TestPanicRecovery(t *testing.T) {
	p := New(1, 10)
	var count atomic.Int32

	// Submit a panicking task
	p.Submit(func() {
		panic("test panic")
	})
	// Submit a normal task after
	p.Submit(func() {
		count.Add(1)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p.Shutdown(ctx)

	if got := count.Load(); got != 1 {
		t.Fatalf("task after panic: count = %d, want 1", got)
	}
}
