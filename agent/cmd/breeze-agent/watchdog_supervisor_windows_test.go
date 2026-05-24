//go:build windows

package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
)

// fakeSCM is a programmable watchdogServiceController. Sequence of states
// is replayed on each QueryState; Start records calls and may return an
// injected error.
type fakeSCM struct {
	mu sync.Mutex

	states     []svc.State
	stateIdx   int
	queryErr   error
	startErr   error
	startCalls int
	queryCalls int
}

func (f *fakeSCM) QueryState(_ string) (svc.State, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queryCalls++
	if f.queryErr != nil {
		return 0, f.queryErr
	}
	if len(f.states) == 0 {
		return svc.Running, nil
	}
	st := f.states[f.stateIdx]
	if f.stateIdx < len(f.states)-1 {
		f.stateIdx++
	}
	return st, nil
}

func (f *fakeSCM) Start(_ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.startCalls++
	// Once Start succeeds, subsequent QueryState should reflect Running so
	// the supervisor's "healthy again" log message is reachable in tests.
	if f.startErr == nil {
		f.states = append(f.states, svc.Running)
		f.stateIdx = len(f.states) - 1
	}
	return f.startErr
}

func (f *fakeSCM) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.startCalls
}

func (f *fakeSCM) queryCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.queryCalls
}

// waitUntil polls cond until it returns true or the timeout fires. Used to
// avoid sleep-based assertions in supervisor tests.
func waitUntil(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("waitUntil: condition not met within timeout")
}

func TestWatchdogSupervisor_RestartsStoppedService(t *testing.T) {
	fake := &fakeSCM{states: []svc.State{svc.Stopped}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	// Tight interval so the test doesn't take a real minute. The initial
	// probe runs immediately so even a slow tick yields a fast first
	// observation.
	go runWatchdogSupervisor(ctx, fake, 10*time.Millisecond, done)

	waitUntil(t, time.Second, func() bool { return fake.callCount() >= 1 })

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("supervisor did not stop after ctx cancel")
	}
}

func TestWatchdogSupervisor_NoopWhenRunning(t *testing.T) {
	fake := &fakeSCM{states: []svc.State{svc.Running}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go runWatchdogSupervisor(ctx, fake, 5*time.Millisecond, done)

	// Wait for several probes to happen, then verify no Start was issued.
	waitUntil(t, time.Second, func() bool { return fake.queryCount() >= 3 })

	if got := fake.callCount(); got != 0 {
		t.Fatalf("Start called %d times; expected 0 when service is Running", got)
	}

	cancel()
	<-done
}

func TestWatchdogSupervisor_BacksOffOnRepeatedFailure(t *testing.T) {
	fake := &fakeSCM{
		queryErr: errors.New("ERROR_SERVICE_DOES_NOT_EXIST"),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go runWatchdogSupervisor(ctx, fake, 5*time.Millisecond, done)

	// Failure path doesn't call Start, but we can verify the goroutine
	// keeps running rather than panicking on repeated query errors.
	waitUntil(t, time.Second, func() bool { return fake.queryCount() >= 3 })

	if got := fake.callCount(); got != 0 {
		t.Fatalf("Start called %d times despite query failure; expected 0", got)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("supervisor did not stop after ctx cancel")
	}
}

func TestWatchdogSupervisor_IgnoresPendingStates(t *testing.T) {
	fake := &fakeSCM{
		states: []svc.State{
			svc.StartPending,
			svc.StopPending,
			svc.ContinuePending,
			svc.PausePending,
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go runWatchdogSupervisor(ctx, fake, 5*time.Millisecond, done)

	waitUntil(t, time.Second, func() bool { return fake.queryCount() >= 4 })

	if got := fake.callCount(); got != 0 {
		t.Fatalf("Start called %d times on pending states; expected 0", got)
	}

	cancel()
	<-done
}

func TestWatchdogSupervisor_RestartsPausedService(t *testing.T) {
	fake := &fakeSCM{states: []svc.State{svc.Paused}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go runWatchdogSupervisor(ctx, fake, 10*time.Millisecond, done)

	waitUntil(t, time.Second, func() bool { return fake.callCount() >= 1 })

	cancel()
	<-done
}
