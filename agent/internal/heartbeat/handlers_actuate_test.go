package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

type fakePamLifetimeManager struct {
	applyResult      pamlifetime.Result
	receivedResult   *pamlifetime.Result
	receivedCalls    int
	handoffCheck     func(error)
	cleanupResult    pamlifetime.Result
	applyCalls       int
	cleanupCalls     int
	reconcileStarted chan<- struct{}
	reconcileRelease <-chan struct{}
	reconcileResults []pamlifetime.Result
	setEnabledErr    error
	setEnabledCalls  []bool
	protocolVersion  int
	available        bool
	applyDeadline    bool
	cleanupDeadline  bool
	setDeadline      bool
	leaseOnce        sync.Once
	leaseGate        chan struct{}
	leaseErr         error
	leaseCalls       int
}

func (m *fakePamLifetimeManager) initLeaseGate() chan struct{} {
	m.leaseOnce.Do(func() {
		m.leaseGate = make(chan struct{}, 1)
		m.leaseGate <- struct{}{}
	})
	return m.leaseGate
}

func (m *fakePamLifetimeManager) Apply(ctx context.Context, _ pamlifetime.ApplyCommand) pamlifetime.Result {
	m.applyCalls++
	_, m.applyDeadline = ctx.Deadline()
	return m.applyResult
}
func (m *fakePamLifetimeManager) ApplyWithReceivedObservation(
	ctx context.Context,
	_ pamlifetime.ApplyCommand,
	handoff func(pamlifetime.Result) error,
) pamlifetime.Result {
	m.receivedCalls++
	_, m.applyDeadline = ctx.Deadline()
	if m.receivedResult == nil {
		return m.applyResult
	}
	err := handoff(*m.receivedResult)
	if m.handoffCheck != nil {
		m.handoffCheck(err)
	}
	if err != nil {
		// Mirrors lifecycleManager.apply's mapping so the handler test proves the
		// handoff returns an error the manager can tell apart. The mapping itself
		// is owned and tested by internal/pamlifetime.
		failed := *m.receivedResult
		failed.State = pamlifetime.ResultFailed
		failed.FailureCode = "received_observation_handoff_failed"
		if errors.Is(err, pamlifetime.ErrReceivedObservationRejected) {
			failed.FailureCode = "received_observation_rejected"
		}
		return failed
	}
	return m.applyResult
}
func (m *fakePamLifetimeManager) Cleanup(ctx context.Context, _ pamlifetime.CleanupCommand) pamlifetime.Result {
	m.cleanupCalls++
	_, m.cleanupDeadline = ctx.Deadline()
	if m.cleanupResult.State == pamlifetime.ResultFailed {
		m.available = false
	}
	return m.cleanupResult
}
func (m *fakePamLifetimeManager) Reconcile(context.Context) []pamlifetime.Result {
	if m.reconcileStarted != nil {
		close(m.reconcileStarted)
	}
	if m.reconcileRelease != nil {
		<-m.reconcileRelease
	}
	return append([]pamlifetime.Result(nil), m.reconcileResults...)
}
func (m *fakePamLifetimeManager) SetEnabled(ctx context.Context, enabled bool) error {
	gate := m.initLeaseGate()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-gate:
	}
	defer func() { gate <- struct{}{} }()
	_, m.setDeadline = ctx.Deadline()
	m.setEnabledCalls = append(m.setEnabledCalls, enabled)
	return m.setEnabledErr
}
func (m *fakePamLifetimeManager) ProtocolVersion() int {
	if m.protocolVersion == 0 {
		return 2
	}
	return m.protocolVersion
}
func (m *fakePamLifetimeManager) Available() bool { return m.available }
func (m *fakePamLifetimeManager) AcquireLegacyActuation(ctx context.Context) (func(), error) {
	gate := m.initLeaseGate()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-gate:
	}
	if m.leaseErr != nil {
		gate <- struct{}{}
		return nil, m.leaseErr
	}
	m.leaseCalls++
	var once sync.Once
	return func() { once.Do(func() { gate <- struct{}{} }) }, nil
}

type frozenPamLifetimeManager struct {
	delegate *fakePamLifetimeManager
}

func (m *frozenPamLifetimeManager) Apply(ctx context.Context, cmd pamlifetime.ApplyCommand) pamlifetime.Result {
	return m.delegate.Apply(ctx, cmd)
}
func (m *frozenPamLifetimeManager) Cleanup(ctx context.Context, cmd pamlifetime.CleanupCommand) pamlifetime.Result {
	return m.delegate.Cleanup(ctx, cmd)
}
func (m *frozenPamLifetimeManager) Reconcile(ctx context.Context) []pamlifetime.Result {
	return m.delegate.Reconcile(ctx)
}
func (m *frozenPamLifetimeManager) SetEnabled(ctx context.Context, enabled bool) error {
	return m.delegate.SetEnabled(ctx, enabled)
}

func pamApplyV2TestCommand(commandID string) Command {
	return Command{ID: commandID, Payload: map[string]any{
		"protocolVersion":        2,
		"actuationId":            "30000000-0000-4000-8000-000000000001",
		"generation":             1,
		"requestId":              "40000000-0000-4000-8000-000000000001",
		"deviceId":               "10000000-0000-4000-8000-000000000003",
		"orgId":                  "10000000-0000-4000-8000-000000000004",
		"targetPath":             `C:\\Windows\\System32\\mmc.exe`,
		"targetHash":             nil,
		"subjectUsername":        `CORP\\alice`,
		"expiresAt":              time.Now().Add(time.Minute).Format(time.RFC3339Nano),
		"serverTime":             time.Now().Format(time.RFC3339Nano),
		"maxRemainingLifetimeMs": 120000,
	}}
}

func readyPamApplyTestHeartbeat(manager pamlifetime.Manager, outbox *pamReconciliationOutbox) *Heartbeat {
	h := &Heartbeat{
		config: &config.Config{
			DeviceID: "10000000-0000-4000-8000-000000000003",
			OrgID:    "10000000-0000-4000-8000-000000000004",
		},
		pamLifetimeManager:      manager,
		pamReconciliationOutbox: outbox,
	}
	h.setPamReconciliationManagerAvailable(true)
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)
	h.uacInterceptionEnabled.Store(true)
	return h
}

func pamReceivedTestObservation() pamlifetime.Result {
	return pamlifetime.Result{
		ProtocolVersion: 2,
		ObservationID:   "20000000-0000-4000-8000-000000000001",
		ActuationID:     "30000000-0000-4000-8000-000000000001",
		Generation:      1,
		State:           pamlifetime.ResultReceived,
		ObservedAt:      time.Now().UTC(),
	}
}

func TestPamApplyV2RequiresReceivedObservationManager(t *testing.T) {
	delegate := &fakePamLifetimeManager{}
	h := readyPamApplyTestHeartbeat(&frozenPamLifetimeManager{delegate: delegate}, newPamReconciliationOutbox(t.TempDir()))

	result := handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
	if result.Status != "failed" || result.Error != "PAM received observation transport unavailable" {
		t.Fatalf("result = %+v", result)
	}
	if delegate.applyCalls != 0 {
		t.Fatalf("frozen Apply called %d times", delegate.applyCalls)
	}
}

// TestPamApplyV2EnqueuesExactEnvelopeCommandBeforeVerification keeps the rc.3
// handoff ordering honest end to end: the observation is durably enqueued for
// the exact envelope command before it is submitted, the submission is
// acknowledged before the manager is allowed to continue, and the pending entry
// is gone by the time the apply proceeds.
func TestPamApplyV2EnqueuesExactEnvelopeCommandBeforeVerification(t *testing.T) {
	received := pamReceivedTestObservation()
	verified := received
	verified.ObservationID = "20000000-0000-4000-8000-000000000002"
	verified.State = pamlifetime.ResultVerifiedActive
	outbox := newPamReconciliationOutbox(t.TempDir())
	manager := &fakePamLifetimeManager{receivedResult: &received, applyResult: verified, available: true}
	var order []string
	manager.handoffCheck = func(err error) {
		if err != nil {
			t.Fatalf("handoff error: %v", err)
		}
		order = append(order, "handoff returned")
		snapshot, snapshotErr := outbox.Snapshot()
		if snapshotErr != nil {
			t.Fatal(snapshotErr)
		}
		if len(snapshot.Pending) != 0 {
			t.Fatalf("acknowledged observation left pending before the apply proceeded: %+v", snapshot)
		}
	}
	h := readyPamApplyTestHeartbeat(manager, outbox)
	h.pamSubmitResultFn = func(_ context.Context, commandID string, observation pamlifetime.Result) (pamResultAcknowledgement, error) {
		order = append(order, "submit")
		if commandID != "60000000-0000-4000-8000-000000000001" || observation != received {
			t.Fatalf("submitted commandID/observation = %q/%+v", commandID, observation)
		}
		snapshot, snapshotErr := outbox.Snapshot()
		if snapshotErr != nil {
			t.Fatal(snapshotErr)
		}
		if len(snapshot.Pending) != 1 || snapshot.Pending[0].CommandID != commandID || snapshot.Pending[0].Observation != received {
			t.Fatalf("outbox at submit time = %+v, want the exact envelope entry pending", snapshot)
		}
		order = append(order, "acknowledged")
		return pamResultAcknowledgement{ProtocolVersion: 1, Classification: pamResultClassificationApplied}, nil
	}

	result := handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
	if result.Status != "completed" || result.Result != verified {
		t.Fatalf("result = %+v", result)
	}
	if manager.applyCalls != 0 || manager.receivedCalls != 1 {
		t.Fatalf("apply calls=%d received calls=%d", manager.applyCalls, manager.receivedCalls)
	}
	if want := []string{"submit", "acknowledged", "handoff returned"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("handoff order = %q, want %q", order, want)
	}
}

// TestPamApplyV2SynchronousReceivedAcknowledgementKeepsTransportAdvertised is
// the rc.2 regression: the observation used to be drained by the reconciliation
// worker after the command result had already reached the server, so the
// received anchor was lost or classified stale. With the acknowledgement taken
// inline the outbox is empty and back-to-back applies must not be refused with
// "received observation transport unavailable".
func TestPamApplyV2SynchronousReceivedAcknowledgementKeepsTransportAdvertised(t *testing.T) {
	for _, classification := range []string{pamResultClassificationApplied, pamResultClassificationDuplicate} {
		t.Run(classification, func(t *testing.T) {
			received := pamReceivedTestObservation()
			verified := received
			verified.ObservationID = "20000000-0000-4000-8000-000000000002"
			verified.State = pamlifetime.ResultVerifiedActive
			outbox := newPamReconciliationOutbox(t.TempDir())
			manager := &fakePamLifetimeManager{receivedResult: &received, applyResult: verified, available: true}
			h := readyPamApplyTestHeartbeat(manager, outbox)
			submits := 0
			h.pamSubmitResultFn = func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
				submits++
				return pamResultAcknowledgement{ProtocolVersion: 1, Classification: classification}, nil
			}

			result := handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
			if result.Status != "completed" || result.Result != verified {
				t.Fatalf("result = %+v", result)
			}
			if submits != 1 {
				t.Fatalf("submit calls = %d, want 1", submits)
			}
			snapshot, err := outbox.Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			if len(snapshot.Pending) != 0 || len(snapshot.Quarantined) != 0 {
				t.Fatalf("outbox after acknowledgement = %+v, want empty", snapshot)
			}
			if !h.pamReceivedObservationReady.Load() || h.pamLifetimeProtocolVersion() != 2 {
				t.Fatalf("received transport stayed blocked after acknowledgement: ready=%v protocol=%d",
					h.pamReceivedObservationReady.Load(), h.pamLifetimeProtocolVersion())
			}
		})
	}
}

// TestPamApplyV2RefusedReceivedAcknowledgementFailsClosed covers the two
// answers that mean the server will not anchor this envelope. The apply must
// fail with its own code - the agent reached the server, so this is not a
// transport outage - and must not leave a pending entry the worker would later
// re-post as a `received` after the command result already said `failed`.
func TestPamApplyV2RefusedReceivedAcknowledgementFailsClosed(t *testing.T) {
	for _, classification := range []string{pamResultClassificationStale, pamResultClassificationRejected} {
		t.Run(classification, func(t *testing.T) {
			received := pamReceivedTestObservation()
			outbox := newPamReconciliationOutbox(t.TempDir())
			manager := &fakePamLifetimeManager{receivedResult: &received, applyResult: received, available: true}
			h := readyPamApplyTestHeartbeat(manager, outbox)
			h.pamSubmitResultFn = func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
				return pamResultAcknowledgement{ProtocolVersion: 1, Classification: classification}, nil
			}

			result := handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
			structured, ok := result.Result.(pamlifetime.Result)
			if result.Status != "completed" || !ok || structured.State != pamlifetime.ResultFailed ||
				structured.FailureCode != "received_observation_rejected" {
				t.Fatalf("result = %+v", result)
			}
			snapshot, err := outbox.Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			if len(snapshot.Pending) != 0 || len(snapshot.Quarantined) != 0 {
				t.Fatalf("outbox after refusal = %+v, want empty", snapshot)
			}
		})
	}
}

// TestPamApplyV2ReceivedSubmitTransportFailureReturnsHandoffFailure keeps the
// transport outage on its existing code, and still clears the pending entry so
// no late `received` can regress the server's observed_state after this apply
// reports failed.
func TestPamApplyV2ReceivedSubmitTransportFailureReturnsHandoffFailure(t *testing.T) {
	received := pamReceivedTestObservation()
	outbox := newPamReconciliationOutbox(t.TempDir())
	manager := &fakePamLifetimeManager{receivedResult: &received, applyResult: received, available: true}
	h := readyPamApplyTestHeartbeat(manager, outbox)
	h.pamSubmitResultFn = func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
		return pamResultAcknowledgement{}, errors.New("connection reset")
	}

	result := handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
	structured, ok := result.Result.(pamlifetime.Result)
	if result.Status != "completed" || !ok || structured.State != pamlifetime.ResultFailed ||
		structured.FailureCode != "received_observation_handoff_failed" {
		t.Fatalf("result = %+v", result)
	}
	snapshot, err := outbox.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Pending) != 0 || len(snapshot.Quarantined) != 0 {
		t.Fatalf("outbox after transport failure = %+v, want empty", snapshot)
	}
}

func TestPamApplyV2EnqueueFailureReturnsStableManagerFailure(t *testing.T) {
	received := pamReceivedTestObservation()
	outbox := newPamReconciliationOutbox(t.TempDir())
	outbox.writeFn = func(*os.File, []byte) error { return errors.New("disk full") }
	manager := &fakePamLifetimeManager{receivedResult: &received, applyResult: received, available: true}
	h := readyPamApplyTestHeartbeat(manager, outbox)
	submits := 0
	h.pamSubmitResultFn = func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
		submits++
		return pamResultAcknowledgement{ProtocolVersion: 1, Classification: pamResultClassificationApplied}, nil
	}

	result := handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
	structured, ok := result.Result.(pamlifetime.Result)
	if result.Status != "completed" || !ok || structured.State != pamlifetime.ResultFailed || structured.FailureCode != "received_observation_handoff_failed" {
		t.Fatalf("result = %+v", result)
	}
	if manager.applyCalls != 0 || manager.receivedCalls != 1 {
		t.Fatalf("apply calls=%d received calls=%d", manager.applyCalls, manager.receivedCalls)
	}
	if submits != 0 {
		t.Fatalf("submit calls = %d, want 0: an observation that was never durable must not be submitted", submits)
	}
}

func TestPamCleanupV2DoesNotRequireReceivedObservationManager(t *testing.T) {
	cleaned := pamlifetime.Result{ProtocolVersion: 2, State: pamlifetime.ResultCleaned}
	delegate := &fakePamLifetimeManager{cleanupResult: cleaned}
	h := readyPamApplyTestHeartbeat(&frozenPamLifetimeManager{delegate: delegate}, nil)

	result := handlePamCleanupV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2,
		"actuationId":     "30000000-0000-4000-8000-000000000001",
		"generation":      2,
		"requestId":       "40000000-0000-4000-8000-000000000001",
		"deviceId":        "10000000-0000-4000-8000-000000000003",
		"orgId":           "10000000-0000-4000-8000-000000000004",
	}})
	if result.Status != "completed" || delegate.cleanupCalls != 1 {
		t.Fatalf("result=%+v cleanup calls=%d", result, delegate.cleanupCalls)
	}
}

func TestPamCleanupV2AllowsReceivedObservationTransportBlocked(t *testing.T) {
	cleaned := pamlifetime.Result{ProtocolVersion: 2, State: pamlifetime.ResultCleaned}
	manager := &fakePamLifetimeManager{cleanupResult: cleaned}
	h := readyPamApplyTestHeartbeat(manager, nil)
	h.pamReceivedObservationReady.Store(false)

	result := handlePamCleanupV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2,
		"actuationId":     "30000000-0000-4000-8000-000000000001",
		"generation":      2,
		"requestId":       "40000000-0000-4000-8000-000000000001",
		"deviceId":        "10000000-0000-4000-8000-000000000003",
		"orgId":           "10000000-0000-4000-8000-000000000004",
	}})
	if result.Status != "completed" || manager.cleanupCalls != 1 {
		t.Fatalf("result=%+v cleanup calls=%d", result, manager.cleanupCalls)
	}
}

func readyLegacyHeartbeat(manager *fakePamLifetimeManager) *Heartbeat {
	manager.available = true
	h := &Heartbeat{pamLifetimeManager: manager}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)
	h.uacInterceptionEnabled.Store(true)
	return h
}

func TestPamLifetimeV2CanonicalDispatchFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "pam-lifetime-v2-command-contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Apply   map[string]any `json:"apply"`
		Cleanup map[string]any `json:"cleanup"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}

	expiresAt := time.Date(2026, 8, 27, 12, 1, 0, 0, time.UTC)
	serverTime := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	wantApply := pamlifetime.ApplyCommand{
		ProtocolVersion: 2,
		ActuationID:     "30000000-0000-4000-8000-000000000001", Generation: 4,
		RequestID:  "30000000-0000-4000-8000-000000000004",
		DeviceID:   "30000000-0000-4000-8000-000000000003",
		OrgID:      "30000000-0000-4000-8000-000000000002",
		TargetPath: `C:\Program Files\Fixture\fixture.exe`, TargetHash: nil,
		SubjectUsername: `CORP\operator`, ExpiresAt: expiresAt, ServerTime: serverTime,
		MaxRemainingLifetimeMS: 60000,
	}
	var gotApply pamlifetime.ApplyCommand
	if err := decodePamLifetimePayload(fixture.Apply, &gotApply); err != nil {
		t.Fatalf("decode apply fixture: %v", err)
	}
	if !reflect.DeepEqual(gotApply, wantApply) {
		t.Fatalf("apply fixture = %#v, want %#v", gotApply, wantApply)
	}

	wantCleanup := pamlifetime.CleanupCommand{
		ProtocolVersion: 2,
		ActuationID:     "30000000-0000-4000-8000-000000000001", Generation: 5,
		RequestID: "30000000-0000-4000-8000-000000000004",
		DeviceID:  "30000000-0000-4000-8000-000000000003",
		OrgID:     "30000000-0000-4000-8000-000000000002",
	}
	var gotCleanup pamlifetime.CleanupCommand
	if err := decodePamLifetimePayload(fixture.Cleanup, &gotCleanup); err != nil {
		t.Fatalf("decode cleanup fixture: %v", err)
	}
	if !reflect.DeepEqual(gotCleanup, wantCleanup) {
		t.Fatalf("cleanup fixture = %#v, want %#v", gotCleanup, wantCleanup)
	}

	fixture.Apply["unknownField"] = true
	if err := decodePamLifetimePayload(fixture.Apply, &gotApply); err == nil {
		t.Fatal("strict decoder accepted unknown apply field")
	}
}

func TestPamLifetimeV2HandlersReturnSharedStructuredResult(t *testing.T) {
	apply := pamlifetime.Result{ProtocolVersion: 2, ObservationID: "10000000-0000-4000-8000-000000000009", ActuationID: "10000000-0000-4000-8000-000000000001", Generation: 1, State: pamlifetime.ResultFailed, ObservedAt: time.Now(), FailureCode: pamlifetime.FailureUnsupportedPlatform}
	cleanup := apply
	cleanup.Generation = 2
	h := &Heartbeat{config: &config.Config{DeviceID: "10000000-0000-4000-8000-000000000003", OrgID: "10000000-0000-4000-8000-000000000004"}, pamLifetimeManager: &fakePamLifetimeManager{applyResult: apply, cleanupResult: cleanup}}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)
	h.uacInterceptionEnabled.Store(true)

	applyResult := handlePamApplyV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2, "actuationId": apply.ActuationID, "generation": 1,
		"requestId": "10000000-0000-4000-8000-000000000002", "deviceId": "10000000-0000-4000-8000-000000000003", "orgId": "10000000-0000-4000-8000-000000000004",
		"targetPath": `C:\\Windows\\System32\\mmc.exe`, "targetHash": nil, "subjectUsername": `CORP\\alice`,
		"expiresAt": time.Now().Add(time.Minute).Format(time.RFC3339Nano), "serverTime": time.Now().Format(time.RFC3339Nano), "maxRemainingLifetimeMs": 120000,
	}})
	if applyResult.Status != "completed" || applyResult.Result != apply {
		t.Fatalf("apply result = %#v", applyResult)
	}
	cleanupResult := handlePamCleanupV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2, "actuationId": apply.ActuationID, "generation": 2,
		"requestId": "10000000-0000-4000-8000-000000000002", "deviceId": "10000000-0000-4000-8000-000000000003", "orgId": "10000000-0000-4000-8000-000000000004",
	}})
	if cleanupResult.Status != "completed" || cleanupResult.Result != cleanup {
		t.Fatalf("cleanup result = %#v", cleanupResult)
	}
	manager := h.pamLifetimeManager.(*fakePamLifetimeManager)
	if !manager.applyDeadline || !manager.cleanupDeadline {
		t.Fatalf("v2 handler contexts missing deadlines: apply=%v cleanup=%v", manager.applyDeadline, manager.cleanupDeadline)
	}
}

func TestPamLifetimeV2HandlersRejectCrossTenantIdentityBeforeManager(t *testing.T) {
	manager := &fakePamLifetimeManager{}
	h := &Heartbeat{config: &config.Config{DeviceID: "10000000-0000-4000-8000-000000000003", OrgID: "10000000-0000-4000-8000-000000000004"}, pamLifetimeManager: manager}
	result := handlePamCleanupV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2, "actuationId": "10000000-0000-4000-8000-000000000001", "generation": 2,
		"requestId": "10000000-0000-4000-8000-000000000002", "deviceId": "10000000-0000-4000-8000-000000000099", "orgId": "10000000-0000-4000-8000-000000000004",
	}})
	if result.Status != "failed" || manager.cleanupCalls != 0 {
		t.Fatalf("result=%+v cleanupCalls=%d", result, manager.cleanupCalls)
	}
}

func TestPamApplyAdmissionRequiresVerifiedEnabledPolicy(t *testing.T) {
	manager := &fakePamLifetimeManager{}
	h := &Heartbeat{config: &config.Config{DeviceID: "10000000-0000-4000-8000-000000000003", OrgID: "10000000-0000-4000-8000-000000000004"}, pamLifetimeManager: manager}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)

	result := handlePamApplyV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2, "actuationId": "10000000-0000-4000-8000-000000000001", "generation": 1,
		"requestId": "10000000-0000-4000-8000-000000000002", "deviceId": "10000000-0000-4000-8000-000000000003", "orgId": "10000000-0000-4000-8000-000000000004",
		"targetPath": `C:\\Windows\\System32\\mmc.exe`, "targetHash": nil, "subjectUsername": `CORP\\alice`,
		"expiresAt": time.Now().Add(time.Minute).Format(time.RFC3339Nano), "serverTime": time.Now().Format(time.RFC3339Nano), "maxRemainingLifetimeMs": 120000,
	}})

	if result.Status != "failed" || manager.applyCalls != 0 {
		t.Fatalf("disabled policy apply result=%+v applyCalls=%d", result, manager.applyCalls)
	}
}

func TestPamCommandAdmissionStaysClosedUntilReconcileFinishes(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	manager := &fakePamLifetimeManager{reconcileStarted: started, reconcileRelease: release, available: true}
	h := &Heartbeat{config: &config.Config{DeviceID: "10000000-0000-4000-8000-000000000003", OrgID: "10000000-0000-4000-8000-000000000004"}, pamLifetimeManager: manager}
	done := make(chan struct{})
	go func() {
		h.ReconcilePAMLifetime(context.Background())
		close(done)
	}()
	<-started
	if got := h.pamLifetimeProtocolVersion(); got != 0 {
		t.Fatalf("protocol during reconciliation = %d, want 0", got)
	}

	blocked := handlePamCleanupV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2, "actuationId": "10000000-0000-4000-8000-000000000001", "generation": 2,
		"requestId": "10000000-0000-4000-8000-000000000002", "deviceId": "10000000-0000-4000-8000-000000000003", "orgId": "10000000-0000-4000-8000-000000000004",
	}})
	if blocked.Status != "failed" || manager.cleanupCalls != 0 {
		t.Fatalf("command admitted during reconcile: result=%+v calls=%d", blocked, manager.cleanupCalls)
	}
	close(release)
	<-done
	if got := h.pamLifetimeProtocolVersion(); got != 2 {
		t.Fatalf("protocol after verified reconciliation = %d, want 2", got)
	}
	_ = handlePamCleanupV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2, "actuationId": "10000000-0000-4000-8000-000000000001", "generation": 2,
		"requestId": "10000000-0000-4000-8000-000000000002", "deviceId": "10000000-0000-4000-8000-000000000003", "orgId": "10000000-0000-4000-8000-000000000004",
	}})
	if manager.cleanupCalls != 1 {
		t.Fatalf("command not admitted after reconcile: calls=%d", manager.cleanupCalls)
	}
}

func TestSetStatePathInitializesFailClosedPamLifetimeManager(t *testing.T) {
	h := &Heartbeat{}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)
	h.SetStatePath(filepath.Join(t.TempDir(), "agent-state.json"))
	if h.pamLifetimeManager == nil {
		t.Fatal("PAM lifetime manager was not initialized")
	}
	if h.pamReconciled.Load() || h.pamReceivedObservationReady.Load() || h.pamVerificationAvailable.Load() {
		t.Fatal("SetStatePath did not close PAM admission before startup reconciliation")
	}
}

type fakeElevationManager struct {
	cred        elevaccount.Credential
	promoteErr  error
	promoteSeen int
	demoteSeen  int
}

func (m *fakeElevationManager) EnsureProvisioned() error { return nil }

func (m *fakeElevationManager) Promote(context.Context) (elevaccount.Credential, error) {
	m.promoteSeen++
	if m.promoteErr != nil {
		return elevaccount.Credential{}, m.promoteErr
	}
	return m.cred, nil
}

func (m *fakeElevationManager) Demote(context.Context) error {
	m.demoteSeen++
	return nil
}

type fakeActuator struct {
	trigger func(context.Context, pamactuator.Request) pamactuator.Result
	dismiss func(context.Context) pamactuator.Result
}

func (a fakeActuator) Trigger(ctx context.Context, req pamactuator.Request) pamactuator.Result {
	return a.trigger(ctx, req)
}

func (a fakeActuator) Dismiss(ctx context.Context) pamactuator.Result {
	if a.dismiss == nil {
		// Fail-safe default matching the production non-windows stub, so a
		// deny-path test that forgets to wire `dismiss` fails loud instead of
		// silently reporting a successful dismissal.
		return pamactuator.Result{Success: false, Reason: "unsupported_platform"}
	}
	return a.dismiss(ctx)
}

func TestParseActuatePayloadAcceptsSlimGoSignal(t *testing.T) {
	payload, err := parseActuatePayload(map[string]any{
		"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		"timeoutMs":          float64(5000),
	})
	if err != nil {
		t.Fatalf("parseActuatePayload returned error: %v", err)
	}
	if payload.ElevationRequestID != "cccccccc-cccc-4ccc-8ccc-cccccccccccc" {
		t.Fatalf("ElevationRequestID = %q", payload.ElevationRequestID)
	}
	if payload.Username != "" || payload.Password != "" {
		t.Fatalf("deprecated credential fields should be empty, got %+v", payload)
	}
	if payload.TimeoutMs != 5000 {
		t.Fatalf("TimeoutMs = %d, want 5000", payload.TimeoutMs)
	}
}

func TestParseActuatePayloadIgnoresDeprecatedCredentials(t *testing.T) {
	payload, err := parseActuatePayload(map[string]any{
		"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		"username":           "server-user",
		"password":           "server-password",
	})
	if err != nil {
		t.Fatalf("parseActuatePayload returned error: %v", err)
	}
	if payload.Username != "server-user" || payload.Password != "server-password" {
		t.Fatalf("expected deprecated fields to parse but be ignored later, got %+v", payload)
	}
}

func TestHandleActuateElevationUsesLocalCredentialAndDemotes(t *testing.T) {
	manager := &fakeElevationManager{
		cred: elevaccount.Credential{Username: "~breeze_elev", Password: "minted-local-secret"},
	}
	var gotReq pamactuator.Request
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(_ context.Context, req pamactuator.Request) pamactuator.Result {
			gotReq = req
			return pamactuator.Result{Success: true, Reason: "ok", DetailMessage: "typed"}
		}}
	})

	result := handleActuateElevation(readyLegacyHeartbeat(&fakePamLifetimeManager{}), Command{
		ID:   "cmd-1",
		Type: tools.CmdActuateElevation,
		Payload: map[string]any{
			"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			"username":           "payload-user",
			"password":           "payload-password",
			"timeoutMs":          float64(5000),
		},
	})

	if result.Status != "completed" {
		t.Fatalf("Status = %q, want completed: %+v", result.Status, result)
	}
	if gotReq.Username != "~breeze_elev" {
		t.Fatalf("actuator username = %q, want local credential", gotReq.Username)
	}
	if gotReq.Password != "minted-local-secret" {
		t.Fatalf("actuator password = %q, want minted local secret", gotReq.Password)
	}
	if manager.promoteSeen != 1 {
		t.Fatalf("Promote called %d times, want 1", manager.promoteSeen)
	}
	if manager.demoteSeen != 1 {
		t.Fatalf("Demote called %d times, want 1", manager.demoteSeen)
	}

	var out actuateResult
	if err := json.Unmarshal([]byte(result.Stdout), &out); err != nil {
		t.Fatalf("stdout is not actuateResult JSON: %v", err)
	}
	if !out.Success || out.Reason != "ok" {
		t.Fatalf("unexpected actuate result: %+v", out)
	}
}

func TestHandleActuateElevationDemotesWhenActuatorPanics(t *testing.T) {
	manager := &fakeElevationManager{
		cred: elevaccount.Credential{Username: "~breeze_elev", Password: "minted-local-secret"},
	}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			panic("actuator panic")
		}}
	})

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected actuator panic to propagate")
		}
		if manager.demoteSeen != 1 {
			t.Fatalf("Demote called %d times after panic, want 1", manager.demoteSeen)
		}
	}()

	_ = handleActuateElevation(readyLegacyHeartbeat(&fakePamLifetimeManager{}), Command{
		ID:   "cmd-1",
		Type: tools.CmdActuateElevation,
		Payload: map[string]any{
			"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			"timeoutMs":          float64(5000),
		},
	})
}

func TestHandleActuateElevationPromoteFailureReturnsStructuredResult(t *testing.T) {
	manager := &fakeElevationManager{promoteErr: elevaccount.ErrUnsupportedPlatform}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			t.Fatal("actuator should not run when Promote fails")
			return pamactuator.Result{}
		}}
	})

	result := handleActuateElevation(readyLegacyHeartbeat(&fakePamLifetimeManager{}), Command{
		ID:   "cmd-1",
		Type: tools.CmdActuateElevation,
		Payload: map[string]any{
			"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		},
	})

	if result.Status != "completed" {
		t.Fatalf("Status = %q, want completed", result.Status)
	}
	var out actuateResult
	if err := json.Unmarshal([]byte(result.Stdout), &out); err != nil {
		t.Fatalf("stdout is not actuateResult JSON: %v", err)
	}
	if out.Success {
		t.Fatalf("Success = true, want false")
	}
	if out.Reason != "unsupported_platform" {
		t.Fatalf("Reason = %q, want unsupported_platform", out.Reason)
	}
	if manager.demoteSeen != 0 {
		t.Fatalf("Demote called %d times without successful Promote, want 0", manager.demoteSeen)
	}
}

func TestLegacyActuationFailsClosedBeforePromoteWhenLifecycleAdmissionUnavailable(t *testing.T) {
	cases := []struct {
		name string
		h    *Heartbeat
	}{
		{name: "manager absent", h: &Heartbeat{}},
		{name: "reconciling", h: func() *Heartbeat {
			m := &fakePamLifetimeManager{available: true}
			h := &Heartbeat{pamLifetimeManager: m}
			h.uacInterceptionEnabled.Store(true)
			return h
		}()},
		{name: "verification unavailable", h: func() *Heartbeat {
			m := &fakePamLifetimeManager{available: false}
			h := &Heartbeat{pamLifetimeManager: m}
			h.pamReconciled.Store(true)
			h.uacInterceptionEnabled.Store(true)
			return h
		}()},
		{name: "policy disabled", h: func() *Heartbeat {
			m := &fakePamLifetimeManager{available: true}
			h := &Heartbeat{pamLifetimeManager: m}
			h.pamReconciled.Store(true)
			h.pamVerificationAvailable.Store(true)
			return h
		}()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			account := &fakeElevationManager{cred: elevaccount.Credential{Username: elevaccount.AccountName, Password: "secret"}}
			swapElevationManagerForTest(t, func() elevaccount.AccountManager { return account })
			result := handleActuateElevation(tc.h, Command{Payload: map[string]any{"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}})
			if result.Status != "failed" || account.promoteSeen != 0 {
				t.Fatalf("result=%+v promote=%d", result, account.promoteSeen)
			}
		})
	}
}

func TestSameResponsePolicyDisableBlocksLegacyActuation(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyLegacyHeartbeat(manager)
	account := &fakeElevationManager{cred: elevaccount.Credential{Username: elevaccount.AccountName, Password: "secret"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return account })

	h.handleUACInterception(boolPtr(false))
	result := handleActuateElevation(h, Command{Payload: map[string]any{"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}})

	if result.Status != "failed" || account.promoteSeen != 0 || !manager.setDeadline {
		t.Fatalf("result=%+v promote=%d setDeadline=%v", result, account.promoteSeen, manager.setDeadline)
	}
}

func TestInFlightLegacyActuationSerializesPolicyDisableThroughDemote(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyLegacyHeartbeat(manager)
	account := &fakeElevationManager{cred: elevaccount.Credential{Username: elevaccount.AccountName, Password: "secret"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return account })
	actuatorStarted := make(chan struct{})
	releaseActuator := make(chan struct{})
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			close(actuatorStarted)
			<-releaseActuator
			return pamactuator.Result{Success: true, Reason: "ok"}
		}}
	})
	handlerDone := make(chan tools.CommandResult, 1)
	go func() {
		handlerDone <- handleActuateElevation(h, Command{Payload: map[string]any{"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "timeoutMs": float64(1000)}})
	}()
	<-actuatorStarted
	disableDone := make(chan struct{})
	go func() {
		h.handleUACInterception(boolPtr(false))
		close(disableDone)
	}()
	select {
	case <-disableDone:
		t.Fatal("policy disable crossed in-flight promote/actuate/demote lease")
	case <-time.After(25 * time.Millisecond):
	}
	close(releaseActuator)
	if result := <-handlerDone; result.Status != "completed" {
		t.Fatalf("handler = %+v", result)
	}
	<-disableDone
	if account.demoteSeen != 1 || manager.leaseCalls != 1 {
		t.Fatalf("demote/lease = %d/%d", account.demoteSeen, manager.leaseCalls)
	}
}

func TestDirectCleanupFailureDropsHeartbeatCapabilityAndBlocksApply(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true, cleanupResult: pamlifetime.Result{State: pamlifetime.ResultFailed}}
	h := readyLegacyHeartbeat(manager)
	h.config = &config.Config{DeviceID: "10000000-0000-4000-8000-000000000003", OrgID: "10000000-0000-4000-8000-000000000004"}
	cleanup := handlePamCleanupV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2, "actuationId": "10000000-0000-4000-8000-000000000001", "generation": 2,
		"requestId": "10000000-0000-4000-8000-000000000002", "deviceId": h.config.DeviceID, "orgId": h.config.OrgID,
	}})
	if cleanup.Status != "completed" || h.pamLifetimeProtocolVersion() != 0 {
		t.Fatalf("cleanup/capability = %+v/%d", cleanup, h.pamLifetimeProtocolVersion())
	}
	apply := handlePamApplyV2(h, Command{Payload: map[string]any{
		"protocolVersion": 2, "actuationId": "20000000-0000-4000-8000-000000000001", "generation": 1,
		"requestId": "20000000-0000-4000-8000-000000000002", "deviceId": h.config.DeviceID, "orgId": h.config.OrgID,
		"targetPath": `C:\\Windows\\System32\\mmc.exe`, "subjectUsername": `CORP\\alice`,
		"expiresAt": time.Now().Add(time.Minute).Format(time.RFC3339Nano), "serverTime": time.Now().Format(time.RFC3339Nano), "maxRemainingLifetimeMs": 120000,
	}})
	if apply.Status != "failed" || manager.applyCalls != 0 {
		t.Fatalf("apply=%+v calls=%d", apply, manager.applyCalls)
	}
}

func TestPromoteFailureReason(t *testing.T) {
	if got := promoteFailureReason(elevaccount.ErrUnsupportedPlatform); got != "unsupported_platform" {
		t.Fatalf("unsupported reason = %q", got)
	}
	if got := promoteFailureReason(errors.New("boom")); got != "credential_promote_failed" {
		t.Fatalf("generic reason = %q", got)
	}
}

func TestActuateUsesConfiguredStrategy(t *testing.T) {
	var gotStrategy pamactuator.Strategy
	swapActuatorForTest(t, func(s pamactuator.Strategy) pamactuator.Actuator {
		gotStrategy = s
		return fakeActuator{trigger: func(_ context.Context, r pamactuator.Request) pamactuator.Result {
			return pamactuator.Result{Success: true, Reason: "ok"}
		}}
	})
	h := newTestHeartbeatWithPAMStrategy(t, "token_launch") // helper in this test file
	h.actuateElevation(context.Background(), "req-1", 8000, pamTarget{})
	if gotStrategy != pamactuator.StrategyTokenLaunch {
		t.Fatalf("actuator built with strategy %q, want token_launch", gotStrategy)
	}
}

// TestActuateElevationPassesTargetToActuator proves the pamTarget passed into
// actuateElevation (Task 5: Path B needs to know what to launch) flows
// through to the pamactuator.Request unmodified — the same code path serves
// both the remote (server-echoed) and local (ETW-discovered) callers.
func TestActuateElevationPassesTargetToActuator(t *testing.T) {
	manager := &fakeElevationManager{
		cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"},
	}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

	var gotReq pamactuator.Request
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(_ context.Context, req pamactuator.Request) pamactuator.Result {
			gotReq = req
			return pamactuator.Result{Success: true, Reason: "ok"}
		}}
	})

	h := &Heartbeat{}
	h.actuateElevation(context.Background(), "req-target", 8000, pamTarget{
		Path:        `C:\Windows\System32\mmc.exe`,
		CommandLine: `mmc.exe devmgmt.msc`,
	})

	if gotReq.TargetPath != `C:\Windows\System32\mmc.exe` {
		t.Fatalf("actuator Request.TargetPath = %q, want mmc.exe path", gotReq.TargetPath)
	}
	if gotReq.CommandLine != `mmc.exe devmgmt.msc` {
		t.Fatalf("actuator Request.CommandLine = %q, want devmgmt.msc command line", gotReq.CommandLine)
	}
}

// TestTokenLaunchFailureStillDemotes proves the guaranteed-demote defer in
// actuateElevation covers Path B (token_launch) failures for free: a Trigger
// that reports Success:false (any Reason) must still Demote ~breeze_elev,
// exactly like the sendinput path already covered by
// TestHandleActuateElevationDemotesWhenActuatorPanics. newTestHeartbeatWithPAMStrategy
// installs its own fakeElevationManager, so the manager swap here must happen
// AFTER it to actually take effect (newElevationAccountManager is a single
// package-level var, last writer wins at actuateElevation call time).
func TestTokenLaunchFailureStillDemotes(t *testing.T) {
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			return pamactuator.Result{Success: false, Reason: "create_process_failed"}
		}}
	})
	h := newTestHeartbeatWithPAMStrategy(t, "token_launch")
	manager := &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

	h.actuateElevation(context.Background(), "req-1", 8000, pamTarget{Path: `C:\a.exe`, CommandLine: `a.exe`})

	if manager.demoteSeen != 1 {
		t.Fatalf("Demote called %d times after token_launch failure, want 1", manager.demoteSeen)
	}
}

func swapActuatorForTest(t *testing.T, fn func(pamactuator.Strategy) pamactuator.Actuator) {
	t.Helper()
	orig := newActuator
	newActuator = fn
	t.Cleanup(func() { newActuator = orig })
}

// newTestHeartbeatWithPAMStrategy mirrors newTestHeartbeat (handlers_script_test.go)
// but wires the config strategy field under test and a fake elevation manager
// so actuateElevation actually reaches the actuator instead of short-circuiting
// on the non-Windows Promote stub (elevaccount.ErrUnsupportedPlatform).
func newTestHeartbeatWithPAMStrategy(t *testing.T, strategy string) *Heartbeat {
	t.Helper()
	swapElevationManagerForTest(t, func() elevaccount.AccountManager {
		return &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	})
	return &Heartbeat{
		config: &config.Config{PAMActuatorStrategy: strategy},
	}
}

func swapElevationManagerForTest(t *testing.T, fn func() elevaccount.AccountManager) {
	t.Helper()
	orig := newElevationAccountManager
	newElevationAccountManager = fn
	t.Cleanup(func() { newElevationAccountManager = orig })
}
