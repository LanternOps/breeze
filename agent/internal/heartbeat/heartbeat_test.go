package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
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

func (l *blockingLifecycleShutdown) Mode() string { return "always-on" }

func (l *blockingLifecycleShutdown) SetModeOverride(string) {}

// Lease/readiness methods exist only to satisfy helperLifecycleController —
// this fake covers shutdown ordering, which never touches them.
func (l *blockingLifecycleShutdown) AcquireLease(uint32, ipc.HelperRole, string, time.Duration) error {
	return nil
}

func (l *blockingLifecycleShutdown) RenewLease(uint32, ipc.HelperRole, string, time.Duration) error {
	return nil
}

func (l *blockingLifecycleShutdown) ReleaseLease(uint32, ipc.HelperRole, string) {}

func (l *blockingLifecycleShutdown) WaitForHelperReady(context.Context, sessionbroker.HelperKey) sessionbroker.HelperWaitResult {
	return sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitTimeout}
}

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

func TestBootstrapRetriesUntilItSucceedsThenListens(t *testing.T) {
	// WTSEnumerateSessionsW fails transiently early in Windows boot. One flake
	// must not cost the agent its pipe listener for the whole process lifetime.
	var attempts int32
	listened := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go bootstrapThenListenWithRetry(ctx, func() error {
		if atomic.AddInt32(&attempts, 1) < 3 {
			return errors.New("WTSEnumerateSessionsW: the RPC server is unavailable")
		}
		return nil
	}, func() { close(listened) }, time.Millisecond)

	select {
	case <-listened:
	case <-time.After(2 * time.Second):
		t.Fatal("listener never started despite bootstrap eventually succeeding")
	}
	if got := atomic.LoadInt32(&attempts); got < 3 {
		t.Fatalf("attempts = %d, want >= 3", got)
	}
}

func TestBootstrapRetryStopsOnContextCancel(t *testing.T) {
	var attempts int32
	ctx, cancel := context.WithCancel(context.Background())
	listened := make(chan struct{})

	done := make(chan struct{})
	go func() {
		defer close(done)
		bootstrapThenListenWithRetry(ctx, func() error {
			atomic.AddInt32(&attempts, 1)
			return errors.New("permanent")
		}, func() { close(listened) }, time.Millisecond)
	}()

	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("retry loop did not exit on context cancel")
	}
	select {
	case <-listened:
		t.Fatal("listener started despite bootstrap never succeeding")
	default:
	}
}

// TestHeartbeatPayloadSecurityCapabilitiesJSON pins the exact wire shape the
// server-side heartbeat schema expects (Wave 6 Task 4, security
// remediation): `{"securityCapabilities":{"outboundNetworkPolicyVersion":1}}`.
// A field rename, a dropped `omitempty`-less requirement, or a wrapper-type
// change here would silently desync from apps/api/src/routes/agents/
// schemas.ts without either side's own tests catching it.
func TestHeartbeatPayloadSecurityCapabilitiesJSON(t *testing.T) {
	payload := HeartbeatPayload{
		Status:               "ok",
		AgentVersion:         "1.2.3",
		SecurityCapabilities: SecurityCapabilities{OutboundNetworkPolicyVersion: 1},
	}

	body, err := json.Marshal(&payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	rawCaps, ok := decoded["securityCapabilities"]
	if !ok {
		t.Fatalf("securityCapabilities key missing from marshaled payload: %s", body)
	}
	caps, ok := rawCaps.(map[string]any)
	if !ok {
		t.Fatalf("securityCapabilities is not an object: %#v", rawCaps)
	}
	version, ok := caps["outboundNetworkPolicyVersion"]
	if !ok {
		t.Fatalf("outboundNetworkPolicyVersion key missing: %#v", caps)
	}
	if got, want := version, float64(1); got != want {
		t.Fatalf("outboundNetworkPolicyVersion = %v, want %v", got, want)
	}
}
