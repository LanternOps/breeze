package heartbeat

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

type blockingLifecycleShutdown struct {
	entered chan struct{}
	release chan struct{}
	done    chan struct{}
}

func (l *blockingLifecycleShutdown) Stop() {
	close(l.entered)
	<-l.release
	close(l.done)
}

func (l *blockingLifecycleShutdown) Done() <-chan struct{} { return l.done }

func TestBootstrapHelperLifecycleBeforeBrokerListen(t *testing.T) {
	var order []string
	err := bootstrapThenListen(func() error {
		order = append(order, "bootstrap")
		return nil
	}, func() {
		order = append(order, "listen")
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"bootstrap", "listen"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("startup order = %v, want %v", order, want)
	}
}

func TestBootstrapFailureRefusesBrokerListen(t *testing.T) {
	wantErr := errors.New("detector unavailable")
	listened := false
	err := bootstrapThenListen(func() error { return wantErr }, func() { listened = true })
	if !errors.Is(err, wantErr) {
		t.Fatalf("bootstrapThenListen error = %v, want %v", err, wantErr)
	}
	if listened {
		t.Fatal("broker listened without authoritative lifecycle desired state")
	}
}

func TestHeartbeatStopOrdersBrokerBeforeLifecycleAndWaitsForReap(t *testing.T) {
	var mu sync.Mutex
	var order []string
	appendOrder := func(step string) {
		mu.Lock()
		order = append(order, step)
		mu.Unlock()
	}
	lifecycleEntered := make(chan struct{})
	releaseReap := make(chan struct{})
	h := &Heartbeat{
		stopChan: make(chan struct{}),
		stopBrokerAcceptingAndWait: func(context.Context) error {
			appendOrder("broker-stop-accepting")
			return nil
		},
		stopHelperLifecycleAndWait: func(context.Context) error {
			appendOrder("lifecycle-stop")
			close(lifecycleEntered)
			<-releaseReap
			appendOrder("lifecycle-reaped")
			return nil
		},
		closeSessionBroker: func() {
			appendOrder("broker-close")
		},
	}

	stopped := make(chan struct{})
	go func() {
		h.Stop()
		close(stopped)
	}()
	<-lifecycleEntered
	select {
	case <-stopped:
		t.Fatal("Heartbeat.Stop returned before lifecycle reap completed")
	default:
	}
	mu.Lock()
	beforeRelease := append([]string(nil), order...)
	mu.Unlock()
	if !reflect.DeepEqual(beforeRelease, []string{"broker-stop-accepting", "lifecycle-stop"}) {
		t.Fatalf("shutdown order before reap release = %v", beforeRelease)
	}

	close(releaseReap)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Heartbeat.Stop did not finish after lifecycle reaped")
	}
	mu.Lock()
	got := append([]string(nil), order...)
	mu.Unlock()
	want := []string{"broker-stop-accepting", "lifecycle-stop", "lifecycle-reaped", "broker-close"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("shutdown order = %v, want %v", got, want)
	}
}

func TestHeartbeatTimeoutNeverOverlapsLifecycleCleanupWithBrokerClose(t *testing.T) {
	lifecycle := &blockingLifecycleShutdown{
		entered: make(chan struct{}),
		release: make(chan struct{}),
		done:    make(chan struct{}),
	}
	brokerClosed := make(chan struct{})
	h := &Heartbeat{
		stopChan:                   make(chan struct{}),
		helperLifecycle:            lifecycle,
		shutdownTimeout:            5 * time.Millisecond,
		stopBrokerAcceptingAndWait: func(context.Context) error { return nil },
		closeSessionBroker:         func() { close(brokerClosed) },
	}
	stopped := make(chan struct{})
	go func() {
		h.Stop()
		close(stopped)
	}()
	<-lifecycle.entered
	time.Sleep(20 * time.Millisecond)
	select {
	case <-brokerClosed:
		t.Fatal("broker closed while lifecycle cleanup was still running")
	default:
	}
	close(lifecycle.release)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Heartbeat.Stop did not finish after lifecycle cleanup")
	}
	select {
	case <-brokerClosed:
	default:
		t.Fatal("broker was not closed after lifecycle cleanup")
	}
}
