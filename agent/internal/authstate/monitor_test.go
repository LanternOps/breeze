package authstate

import (
	"sync"
	"testing"
	"time"
)

func TestMonitor_NotDeadInitially(t *testing.T) {
	m := NewMonitor(3)
	if m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=false on fresh monitor")
	}
}

func TestMonitor_NotDeadBeforeThreshold(t *testing.T) {
	m := NewMonitor(3)
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	if m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=false after 2 failures (threshold=3)")
	}
}

func TestMonitor_DeadAtThreshold(t *testing.T) {
	m := NewMonitor(3)
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	if !m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=true after 3 failures")
	}
}

func TestMonitor_SuccessClearsDead(t *testing.T) {
	m := NewMonitor(3)
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	if !m.ShouldSkip() {
		t.Fatal("expected dead after 3 failures")
	}
	m.RecordSuccess()
	if m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=false after RecordSuccess()")
	}
}

func TestMonitor_SuccessResetsCounter(t *testing.T) {
	m := NewMonitor(3)
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	m.RecordSuccess() // reset
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	if m.ShouldSkip() {
		t.Fatal("expected not dead — counter was reset by success")
	}
}

func TestMonitor_BackoffProgression(t *testing.T) {
	m := NewMonitor(1) // threshold=1 so first failure trips it

	m.RecordAuthFailure()
	d1 := m.BackoffDuration()
	if d1 < 800*time.Millisecond || d1 > 1200*time.Millisecond {
		t.Fatalf("expected first backoff ~1s, got %v", d1)
	}

	m.RecordAuthFailure()
	d2 := m.BackoffDuration()
	if d2 < 1600*time.Millisecond || d2 > 2400*time.Millisecond {
		t.Fatalf("expected second backoff ~2s, got %v", d2)
	}
}

func TestMonitor_BackoffCapsAt30s(t *testing.T) {
	m := NewMonitor(1)
	for i := 0; i < 20; i++ {
		m.RecordAuthFailure()
	}
	d := m.BackoffDuration()
	if d > 36*time.Second { // 30s + 20% jitter
		t.Fatalf("expected backoff capped near 30s, got %v", d)
	}
}

func TestMonitor_SuccessResetsBackoff(t *testing.T) {
	m := NewMonitor(1)
	for i := 0; i < 10; i++ {
		m.RecordAuthFailure()
	}
	m.RecordSuccess()
	m.RecordAuthFailure() // re-trip
	d := m.BackoffDuration()
	if d > 1500*time.Millisecond {
		t.Fatalf("expected backoff reset to ~1s after success, got %v", d)
	}
}

func TestMonitor_ConcurrentAccess(t *testing.T) {
	m := NewMonitor(3)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			m.RecordAuthFailure()
		}()
		go func() {
			defer wg.Done()
			m.ShouldSkip()
		}()
		go func() {
			defer wg.Done()
			m.RecordSuccess()
		}()
	}
	wg.Wait()
	// No race detector failures = pass
}
