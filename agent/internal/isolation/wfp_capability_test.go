package isolation

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWFPCapabilityInputs(t *testing.T) {
	failure := errors.New("unavailable")
	for _, tc := range []struct {
		name             string
		engine, recovery error
		scheduler        bool
		activated        bool
		want             Capability
	}{
		{"engine", failure, nil, true, true, Capability{Mechanism: "wfp", UnsupportedReason: "bfe_unavailable"}},
		{"recovery", nil, failure, true, true, Capability{Mechanism: "wfp", UnsupportedReason: "recovery_unavailable"}},
		{"scheduler", nil, nil, false, true, Capability{Mechanism: "wfp", UnsupportedReason: "scheduler_unavailable"}},
		{"ready", nil, nil, true, true, Capability{Version: 1, Mechanism: "wfp", Ready: true}},
		{"not activated", nil, nil, true, false, Capability{Mechanism: "wfp", UnsupportedReason: "not_activated"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := wfpCapability(tc.engine, tc.recovery, tc.scheduler, "scheduler details", tc.activated)
			if got != tc.want {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}

func TestWFPReadinessCacheIsCheapBoundedAndRaceFree(t *testing.T) {
	var calls atomic.Int32
	now := time.Unix(1000, 0)
	cache := readinessCache{now: func() time.Time { return now }, probe: func(context.Context) readinessInputs { calls.Add(1); return readinessInputs{schedulerReady: true} }}
	cache.refresh(context.Background(), false)
	var wg sync.WaitGroup
	for n := 0; n < 40; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for k := 0; k < 10; k++ {
				if got := cache.capability(true); got.Version != 1 {
					t.Errorf("cache=%+v", got)
				}
				cache.refresh(context.Background(), false)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("repeated probes=%d", calls.Load())
	}
	now = now.Add(readinessMaxAge + time.Second)
	if got := cache.capability(true); got.Ready {
		t.Fatal("stale cache advertised readiness")
	}
	cache.refresh(context.Background(), false)
	if calls.Load() != 2 {
		t.Fatal("expired cache not refreshed")
	}
	cache.refresh(context.Background(), true)
	if calls.Load() != 3 {
		t.Fatal("preapply did not force refresh")
	}
}

func TestWFPCapabilityDoesNotWaitForSlowRefresh(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	cache := readinessCache{probe: func(context.Context) readinessInputs {
		close(entered)
		<-release
		return readinessInputs{schedulerReady: true}
	}}
	done := make(chan struct{})
	go func() { cache.refresh(context.Background(), true); close(done) }()
	<-entered
	got := make(chan Capability, 1)
	go func() { got <- cache.capability(true) }()
	select {
	case <-got:
	case <-time.After(100 * time.Millisecond):
		close(release)
		<-done
		t.Fatal("heartbeat waited for installer/self-test")
	}
	close(release)
	<-done
}
