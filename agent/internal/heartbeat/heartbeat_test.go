package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
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
// remediation; #3409 PR4b):
// `{"securityCapabilities":{"outboundNetworkPolicyVersion":1,"scriptSecretEnvVersion":1}}`.
// A field rename, a dropped `omitempty`-less requirement, or a wrapper-type
// change here would silently desync from apps/api/src/routes/agents/
// schemas.ts without either side's own tests catching it. scriptSecretEnvVersion
// in particular must be emitted even when it is the zero value — the server
// distinguishes "old agent, whole object absent" from "capable agent
// declaring 0" — so this also guards against a stray `omitempty` creeping in.
func TestHeartbeatPayloadSecurityCapabilitiesJSON(t *testing.T) {
	payload := HeartbeatPayload{
		Status:       "ok",
		AgentVersion: "1.2.3",
		SecurityCapabilities: SecurityCapabilities{
			OutboundNetworkPolicyVersion: 1,
			ScriptSecretEnvVersion:       1,
		},
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

	secretEnvVersion, ok := caps["scriptSecretEnvVersion"]
	if !ok {
		t.Fatalf("scriptSecretEnvVersion key missing: %#v", caps)
	}
	if got, want := secretEnvVersion, float64(1); got != want {
		t.Fatalf("scriptSecretEnvVersion = %v, want %v", got, want)
	}

	// Emitted unconditionally: a zero-value SecurityCapabilities must still
	// produce the key (no omitempty), so the server can tell "old agent,
	// object absent" apart from "capable agent declaring 0".
	zeroBody, err := json.Marshal(&HeartbeatPayload{
		Status:       "ok",
		AgentVersion: "1.2.3",
	})
	if err != nil {
		t.Fatalf("marshal zero-value payload: %v", err)
	}
	var zeroDecoded map[string]any
	if err := json.Unmarshal(zeroBody, &zeroDecoded); err != nil {
		t.Fatalf("unmarshal zero-value payload: %v", err)
	}
	zeroCaps, ok := zeroDecoded["securityCapabilities"].(map[string]any)
	if !ok {
		t.Fatalf("securityCapabilities missing/not an object on zero-value payload: %s", zeroBody)
	}
	zeroVersion, ok := zeroCaps["scriptSecretEnvVersion"]
	if !ok {
		t.Fatalf("scriptSecretEnvVersion key missing on zero-value payload (omitempty regression?): %#v", zeroCaps)
	}
	if got, want := zeroVersion, float64(0); got != want {
		t.Fatalf("zero-value scriptSecretEnvVersion = %v, want %v", got, want)
	}
}

func TestHeartbeatPayloadHealthStatusUsesTypedImmutableV1WireKey(t *testing.T) {
	metricsAvailable := true
	monitor := health.NewMonitor()
	monitor.Update("metrics", health.Degraded, "disk pressure")
	snapshot := monitor.Snapshot(health.SnapshotMetadata{
		DeviceID:         "550e8400-e29b-41d4-a716-446655440000",
		AgentVersion:     "1.2.3",
		MetricsAvailable: &metricsAvailable,
		ObservedAt:       time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC),
	})
	payload := HeartbeatPayload{
		Status:       "ok",
		AgentVersion: "1.2.3",
		HealthStatus: &snapshot,
	}

	body, err := json.Marshal(&payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	healthStatus, ok := decoded["healthStatus"].(map[string]any)
	if !ok {
		t.Fatalf("healthStatus missing or wrong shape: %s", body)
	}
	if _, exists := decoded["health_status"]; exists {
		t.Fatalf("snake_case health key must not be emitted: %s", body)
	}
	if _, exists := healthStatus["userHelpers"]; exists {
		t.Fatalf("unrelated userHelpers data leaked into typed health: %s", body)
	}
	if healthStatus["schemaVersion"] != float64(1) || healthStatus["overall"] != "warning" {
		t.Fatalf("healthStatus = %#v, want v1 warning", healthStatus)
	}
}

func TestHeartbeatPayloadOmitsHealthStatusWhenNoMainAgentSnapshotExists(t *testing.T) {
	body, err := json.Marshal(&HeartbeatPayload{Status: "ok", AgentVersion: "1.2.3"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, exists := decoded["healthStatus"]; exists {
		t.Fatalf("healthStatus emitted without a main-agent snapshot: %s", body)
	}
}

func TestSecurityCapabilitiesControlProtocolJSON(t *testing.T) {
	tests := []struct {
		name                string
		capabilities        SecurityCapabilities
		wantPeripheralValue any
		wantRollbackValue   any
		wantPeripheralKey   bool
		wantRollbackKey     bool
		wantPamValue        any
		wantPamKey          bool
	}{
		{
			name: "reports exact supported versions",
			capabilities: SecurityCapabilities{
				PeripheralPolicyProtocolVersion: 2,
				RollbackProtocolVersion:         1,
				PamLifetimeProtocolVersion:      2,
				PamReconciliation: &PamReconciliationStatus{
					UnresolvedCount:                 1,
					QuarantinedCount:                2,
					AwaitingAcknowledgementCount:    3,
					ReceivedObservationPendingCount: 1,
					BlockingReason:                  pamReconciliationReasonQuarantined,
				},
			},
			wantPeripheralValue: float64(2),
			wantRollbackValue:   float64(1),
			wantPeripheralKey:   true,
			wantRollbackKey:     true,
			wantPamValue:        float64(2),
			wantPamKey:          true,
		},
		{name: "omits unsupported zero values"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(tt.capabilities)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			var decoded map[string]any
			if err := json.Unmarshal(body, &decoded); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			peripheralValue, peripheralPresent := decoded["peripheralPolicyProtocolVersion"]
			if peripheralPresent != tt.wantPeripheralKey {
				t.Fatalf("peripheralPolicyProtocolVersion present = %v, want %v; payload=%s", peripheralPresent, tt.wantPeripheralKey, body)
			}
			if peripheralPresent && peripheralValue != tt.wantPeripheralValue {
				t.Fatalf("peripheralPolicyProtocolVersion = %v, want %v", peripheralValue, tt.wantPeripheralValue)
			}

			rollbackValue, rollbackPresent := decoded["rollbackProtocolVersion"]
			if rollbackPresent != tt.wantRollbackKey {
				t.Fatalf("rollbackProtocolVersion present = %v, want %v; payload=%s", rollbackPresent, tt.wantRollbackKey, body)
			}
			if rollbackPresent && rollbackValue != tt.wantRollbackValue {
				t.Fatalf("rollbackProtocolVersion = %v, want %v", rollbackValue, tt.wantRollbackValue)
			}

			pamValue, pamPresent := decoded["pamLifetimeProtocolVersion"]
			if pamPresent != tt.wantPamKey {
				t.Fatalf("pamLifetimeProtocolVersion present = %v, want %v; payload=%s", pamPresent, tt.wantPamKey, body)
			}
			if pamPresent && pamValue != tt.wantPamValue {
				t.Fatalf("pamLifetimeProtocolVersion = %v, want %v", pamValue, tt.wantPamValue)
			}
			if tt.capabilities.PamReconciliation != nil {
				got, ok := decoded["pamReconciliation"].(map[string]any)
				if !ok {
					t.Fatalf("pamReconciliation missing/not an object: %s", body)
				}
				if got["unresolvedCount"] != float64(1) || got["quarantinedCount"] != float64(2) ||
					got["awaitingAcknowledgementCount"] != float64(3) || got["receivedObservationPendingCount"] != float64(1) ||
					got["blockingReason"] != pamReconciliationReasonQuarantined {
					t.Fatalf("pamReconciliation = %+v", got)
				}
			} else if _, present := decoded["pamReconciliation"]; present {
				t.Fatalf("zero-value pamReconciliation unexpectedly present: %s", body)
			}
		})
	}
}

func TestPamReconciliationStatusReceivedObservationTransport(t *testing.T) {
	h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
	received := deterministicTestPamObservation(t)
	received.State = pamlifetime.ResultReceived
	ordinary := received
	ordinary.ObservationID = "40000000-0000-4000-8000-000000000004"
	ordinary.State = pamlifetime.ResultFailed
	quarantined := ordinary
	quarantined.ObservationID = "40000000-0000-4000-8000-000000000005"
	if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, received); err != nil {
		t.Fatal(err)
	}
	if err := h.pamReconciliationOutbox.Enqueue(testPamNewCommandID, ordinary); err != nil {
		t.Fatal(err)
	}
	if err := h.pamReconciliationOutbox.Enqueue("10000000-0000-4000-8000-000000000003", quarantined); err != nil {
		t.Fatal(err)
	}
	if err := h.pamReconciliationOutbox.Quarantine("10000000-0000-4000-8000-000000000003", quarantined.ObservationID, "same_command_rejected"); err != nil {
		t.Fatal(err)
	}
	h.pamReconciliationMu.Lock()
	h.pamReconciliationAcknowledgementUnavailable = true
	h.pamReconciliationMu.Unlock()

	status := h.pamReconciliationStatus()
	if status.UnresolvedCount != 0 || status.QuarantinedCount != 1 || status.AwaitingAcknowledgementCount != 2 || status.ReceivedObservationPendingCount != 1 || status.BlockingReason != pamReconciliationReasonReceivedObservationTransport {
		t.Fatalf("status = %+v", status)
	}
}

func TestPamReconciliationStatusExactCountsAndReasonPriority(t *testing.T) {
	h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
	first := deterministicTestPamObservation(t)
	second := first
	second.ObservationID = "40000000-0000-4000-8000-000000000002"
	second.ActuationID = "50000000-0000-4000-8000-000000000002"
	h.pamReconciliationMu.Lock()
	h.pamReconciliationStaged[first.ObservationID] = first
	h.pamReconciliationStaged[second.ObservationID] = second
	h.pamReconciliationStagedReasons[first.ObservationID] = pamReconciliationReasonResolverUnavailable
	h.pamReconciliationStagedReasons[second.ObservationID] = pamReconciliationReasonEnqueueFailed
	h.pamReconciliationMu.Unlock()
	if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, first); err != nil {
		t.Fatal(err)
	}
	quarantined := second
	quarantined.ObservationID = "40000000-0000-4000-8000-000000000003"
	if err := h.pamReconciliationOutbox.Enqueue(testPamNewCommandID, quarantined); err != nil {
		t.Fatal(err)
	}
	if err := h.pamReconciliationOutbox.Quarantine(testPamNewCommandID, quarantined.ObservationID, "same_command_rejected"); err != nil {
		t.Fatal(err)
	}

	status := h.pamReconciliationStatus()
	if status.UnresolvedCount != 2 || status.QuarantinedCount != 1 || status.AwaitingAcknowledgementCount != 1 {
		t.Fatalf("status counts = %+v", status)
	}
	if status.BlockingReason != pamReconciliationReasonResolverUnavailable {
		t.Fatalf("blocking reason = %q, want resolver priority", status.BlockingReason)
	}
}

func TestPamReconciliationStatusCapabilityGating(t *testing.T) {
	for _, test := range []struct {
		name            string
		reason          string
		quarantine      bool
		pendingOnly     bool
		wantProtocol    int
		wantAwaiting    int
		wantBlockReason string
	}{
		{name: "binding unresolved", reason: pamReconciliationReasonBindingUnresolved},
		{name: "enqueue failed", reason: pamReconciliationReasonEnqueueFailed},
		{name: "quarantined", quarantine: true, wantBlockReason: pamReconciliationReasonQuarantined},
		{name: "awaiting acknowledgement", pendingOnly: true, wantProtocol: 2, wantAwaiting: 1, wantBlockReason: pamReconciliationReasonAcknowledgementUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
			h.pamVerificationAvailable.Store(true)
			h.setPamReconciliationManagerAvailable(true)
			observation := deterministicTestPamObservation(t)
			if test.pendingOnly || test.quarantine {
				if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
					t.Fatal(err)
				}
			}
			if test.quarantine {
				if err := h.pamReconciliationOutbox.Quarantine(testPamCommandID, observation.ObservationID, "same_command_rejected"); err != nil {
					t.Fatal(err)
				}
			} else if test.reason != "" {
				h.pamReconciliationMu.Lock()
				h.pamReconciliationStaged[observation.ObservationID] = observation
				h.pamReconciliationStagedReasons[observation.ObservationID] = test.reason
				h.pamReconciliationMu.Unlock()
			}
			if test.pendingOnly {
				h.pamReconciliationMu.Lock()
				h.pamReconciliationAcknowledgementUnavailable = true
				h.pamReconciliationMu.Unlock()
			}
			h.recomputePamReconciliationReadiness()
			if got := h.pamLifetimeProtocolVersion(); got != test.wantProtocol {
				t.Fatalf("protocol = %d, want %d", got, test.wantProtocol)
			}
			status := h.pamReconciliationStatus()
			if status.AwaitingAcknowledgementCount != test.wantAwaiting {
				t.Fatalf("awaiting = %d, want %d", status.AwaitingAcknowledgementCount, test.wantAwaiting)
			}
			wantReason := test.wantBlockReason
			if wantReason == "" {
				wantReason = test.reason
			}
			if status.BlockingReason != wantReason {
				t.Fatalf("reason = %q, want %q", status.BlockingReason, wantReason)
			}
		})
	}
}

func TestPamReconciliationStatusLogsOnlyChangedSignature(t *testing.T) {
	h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
	var logged []PamReconciliationStatus
	var loggedPath string
	var loggedSample pamReconciliationLogSample
	h.pamReconciliationLogFn = func(status PamReconciliationStatus, path string, sample pamReconciliationLogSample) {
		logged = append(logged, status)
		loggedPath = path
		loggedSample = sample
	}

	h.pamReconciliationStatus()
	h.pamReconciliationStatus()
	if len(logged) != 1 {
		t.Fatalf("unchanged status logged %d times, want 1", len(logged))
	}
	observation := deterministicTestPamObservation(t)
	h.pamReconciliationMu.Lock()
	h.pamReconciliationStaged[observation.ObservationID] = observation
	h.pamReconciliationStagedReasons[observation.ObservationID] = pamReconciliationReasonBindingUnresolved
	h.pamReconciliationMu.Unlock()
	h.pamReconciliationStatus()
	h.pamReconciliationStatus()
	if len(logged) != 2 || logged[1].BlockingReason != pamReconciliationReasonBindingUnresolved {
		t.Fatalf("transition logs = %+v", logged)
	}
	if loggedPath != h.pamReconciliationOutbox.root || loggedSample.ActuationID != observation.ActuationID ||
		loggedSample.Generation != observation.Generation || loggedSample.ObservationID != observation.ObservationID {
		t.Fatalf("safe structured log fields path=%q sample=%+v", loggedPath, loggedSample)
	}
}

func TestPamReconciliationStatusReportsUnreadableOutbox(t *testing.T) {
	h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
	if err := os.MkdirAll(h.pamReconciliationOutbox.pendingDir, 0700); err != nil {
		t.Fatal(err)
	}
	path := h.pamReconciliationOutbox.entryPath(pamReconciliationStatePending, testPamCommandID, testPamObservationID)
	if err := os.WriteFile(path, []byte("not-json"), 0600); err != nil {
		t.Fatal(err)
	}
	status := h.pamReconciliationStatus()
	if status.BlockingReason != pamReconciliationReasonReceivedObservationTransport {
		t.Fatalf("blocking reason = %q, want received_observation_transport", status.BlockingReason)
	}
}
