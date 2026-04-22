package main

import (
	"testing"
	"time"
)

func TestRunWithTimeoutReturnsQuicklyWhenFnIsFast(t *testing.T) {
	start := time.Now()
	runWithTimeout("fast", 5*time.Second, func() {
		time.Sleep(10 * time.Millisecond)
	})
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("expected fast return, took %v", elapsed)
	}
}

func TestRunWithTimeoutAbandonsHungFn(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	start := time.Now()
	runWithTimeout("hung", 100*time.Millisecond, func() {
		<-done // blocks until test end
	})
	elapsed := time.Since(start)
	if elapsed < 100*time.Millisecond {
		t.Fatalf("returned before timeout: %v", elapsed)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("exceeded timeout by too much: %v", elapsed)
	}
}
