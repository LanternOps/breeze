package heartbeat

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"
)

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
