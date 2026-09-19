package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

const testPamAgentID = "agent-primary-1"

func newPamTransportHeartbeat(serverURL string, client *http.Client) *Heartbeat {
	return &Heartbeat{
		config: &config.Config{
			ServerURL: serverURL,
			AgentID:   testPamAgentID,
			AuthToken: "pam-transport-token",
		},
		client:   client,
		retryCfg: httputil.RetryConfig{},
	}
}

func TestPamReconciliationTransportResolverChunksCorrelatesAndAuthenticates(t *testing.T) {
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if want := "/api/v1/agents/" + testPamAgentID + "/pam/reconciliation-bindings"; r.URL.Path != want {
			t.Errorf("path = %q, want %q", r.URL.Path, want)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer pam-transport-token" {
			t.Errorf("authorization = %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("content-type = %q", got)
		}
		var request struct {
			ProtocolVersion int                   `json:"protocolVersion"`
			Candidates      []pamBindingCandidate `json:"candidates"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if request.ProtocolVersion != 1 {
			t.Errorf("protocolVersion = %d", request.ProtocolVersion)
		}
		if len(request.Candidates) == 0 || len(request.Candidates) > 100 {
			t.Errorf("candidate count = %d, want 1..100", len(request.Candidates))
		}
		requestCount.Add(1)

		dispositions := make([]pamBindingDisposition, 0, len(request.Candidates))
		for i := len(request.Candidates) - 1; i >= 0; i-- {
			dispositions = append(dispositions, pamBindingDisposition{
				Status:        pamBindingStatusUnresolved,
				ObservationID: request.Candidates[i].ObservationID,
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"protocolVersion": 1,
			"dispositions":    dispositions,
		})
	}))
	defer server.Close()

	candidates := make([]pamBindingCandidate, 205)
	for i := range candidates {
		candidates[i] = pamBindingCandidate{
			ObservationID: fmt.Sprintf("20000000-0000-4000-8000-%012d", i+1),
			ActuationID:   "30000000-0000-4000-8000-000000000001",
			Generation:    uint64(i + 1),
		}
	}
	dispositions, err := newPamTransportHeartbeat(server.URL, server.Client()).resolvePamBindings(context.Background(), candidates)
	if err != nil {
		t.Fatal(err)
	}
	if requestCount.Load() != 3 {
		t.Fatalf("request count = %d, want 3", requestCount.Load())
	}
	if len(dispositions) != len(candidates) {
		t.Fatalf("disposition count = %d, want %d", len(dispositions), len(candidates))
	}
	for i := range dispositions {
		if dispositions[i].ObservationID != candidates[i].ObservationID {
			t.Fatalf("disposition[%d] observation = %q, want %q", i, dispositions[i].ObservationID, candidates[i].ObservationID)
		}
	}
}

func TestPamReconciliationTransportResolverRejectsInvalidResponses(t *testing.T) {
	candidate := pamBindingCandidate{
		ObservationID: testPamObservationID,
		ActuationID:   "30000000-0000-4000-8000-000000000001",
		Generation:    3,
	}
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{name: "missing route", status: http.StatusNotFound, body: `{"error":"not found"}`},
		{name: "non-200", status: http.StatusForbidden, body: `{"error":"forbidden"}`},
		{name: "malformed", status: http.StatusOK, body: `{"protocolVersion":`},
		{name: "wrong protocol", status: http.StatusOK, body: `{"protocolVersion":2,"dispositions":[{"status":"unresolved","observationId":"20000000-0000-4000-8000-000000000001"}]}`},
		{name: "missing disposition", status: http.StatusOK, body: `{"protocolVersion":1,"dispositions":[]}`},
		{name: "unknown observation", status: http.StatusOK, body: `{"protocolVersion":1,"dispositions":[{"status":"unresolved","observationId":"20000000-0000-4000-8000-000000000099"}]}`},
		{name: "invalid status", status: http.StatusOK, body: `{"protocolVersion":1,"dispositions":[{"status":"accepted","observationId":"20000000-0000-4000-8000-000000000001"}]}`},
		{name: "bound missing command", status: http.StatusOK, body: `{"protocolVersion":1,"dispositions":[{"status":"bound","observationId":"20000000-0000-4000-8000-000000000001"}]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			if _, err := newPamTransportHeartbeat(server.URL, server.Client()).resolvePamBindings(context.Background(), []pamBindingCandidate{candidate}); err == nil {
				t.Fatal("expected resolver error")
			}
		})
	}
}

func TestPamReconciliationTransportResultAcknowledgementRoundTrip(t *testing.T) {
	for _, classification := range []string{
		pamResultClassificationApplied,
		pamResultClassificationDuplicate,
		pamResultClassificationStale,
		pamResultClassificationRejected,
	} {
		t.Run(classification, func(t *testing.T) {
			observation := testPamObservation(testPamObservationID)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if want := "/api/v1/agents/" + testPamAgentID + "/commands/" + testPamCommandID + "/result"; r.URL.Path != want {
					t.Errorf("path = %q, want %q", r.URL.Path, want)
				}
				if got := r.Header.Get("Authorization"); got != "Bearer pam-transport-token" {
					t.Errorf("authorization = %q", got)
				}
				var got tools.CommandResult
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Errorf("decode result: %v", err)
					return
				}
				if got.Status != "completed" || got.ExitCode != 0 {
					t.Errorf("command envelope = %+v", got)
				}
				encoded, err := json.Marshal(got.Result)
				if err != nil {
					t.Errorf("marshal structured result: %v", err)
				}
				var structured pamlifetime.Result
				if err := json.Unmarshal(encoded, &structured); err != nil {
					t.Errorf("decode structured result: %v", err)
				}
				if structured != observation {
					t.Errorf("structured result = %+v, want %+v", structured, observation)
				}
				_ = json.NewEncoder(w).Encode(pamResultAcknowledgement{ProtocolVersion: 1, Classification: classification})
			}))
			defer server.Close()

			ack, err := newPamTransportHeartbeat(server.URL, server.Client()).submitPamReconciliationResult(context.Background(), testPamCommandID, observation)
			if err != nil {
				t.Fatal(err)
			}
			if ack.ProtocolVersion != 1 || ack.Classification != classification {
				t.Fatalf("acknowledgement = %+v", ack)
			}
		})
	}
}

func TestPamReconciliationReceivedRouteAcknowledgementRoundTrip(t *testing.T) {
	for _, classification := range []string{
		pamResultClassificationApplied,
		pamResultClassificationDuplicate,
		pamResultClassificationStale,
		pamResultClassificationRejected,
	} {
		t.Run(classification, func(t *testing.T) {
			observation := testPamObservation(testPamObservationID)
			observation.State = pamlifetime.ResultReceived
			observation.FailureCode = ""
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if want := "/api/v1/agents/" + testPamAgentID + "/commands/" + testPamCommandID + "/pam-observations"; r.URL.Path != want {
					t.Errorf("path = %q, want %q", r.URL.Path, want)
				}
				var got struct {
					ProtocolVersion int                `json:"protocolVersion"`
					Observation     pamlifetime.Result `json:"observation"`
				}
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Errorf("decode observation: %v", err)
					return
				}
				if got.ProtocolVersion != 1 || got.Observation != observation {
					t.Errorf("payload = %+v", got)
				}
				_ = json.NewEncoder(w).Encode(pamResultAcknowledgement{ProtocolVersion: 1, Classification: classification})
			}))
			defer server.Close()

			ack, err := newPamTransportHeartbeat(server.URL, server.Client()).submitPamReconciliationResult(context.Background(), testPamCommandID, observation)
			if err != nil {
				t.Fatal(err)
			}
			if ack.ProtocolVersion != 1 || ack.Classification != classification {
				t.Fatalf("acknowledgement = %+v", ack)
			}
		})
	}
}

func TestPamReconciliationStartupResultsStayOnResultRoute(t *testing.T) {
	startup := testPamObservation("")
	manager := &fakePamLifetimeManager{available: true, reconcileResults: []pamlifetime.Result{startup}}
	var submittedState pamlifetime.ResultState
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if want := "/api/v1/agents/" + testPamAgentID + "/commands/" + testPamCommandID + "/result"; r.URL.Path != want {
			t.Errorf("path = %q, want %q", r.URL.Path, want)
		}
		var envelope tools.CommandResult
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(envelope.Result)
		if err != nil {
			t.Fatal(err)
		}
		var result pamlifetime.Result
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		submittedState = result.State
		_ = json.NewEncoder(w).Encode(pamResultAcknowledgement{ProtocolVersion: 1, Classification: pamResultClassificationApplied})
	}))
	defer server.Close()

	h := newPamControllerTestHeartbeat(t, manager)
	h.config.ServerURL = server.URL
	h.config.AgentID = testPamAgentID
	h.config.AuthToken = "pam-transport-token"
	h.client = server.Client()
	h.pamResolveBindingsFn = func(_ context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
		return []pamBindingDisposition{{Status: pamBindingStatusBound, ObservationID: candidates[0].ObservationID, CommandID: testPamCommandID}}, nil
	}
	h.pamSubmitResultFn = nil

	results := h.ReconcilePAMLifetime(context.Background())
	if len(results) != 1 || results[0].State == pamlifetime.ResultReceived || submittedState != pamlifetime.ResultFailed {
		t.Fatalf("startup results=%+v submitted state=%q", results, submittedState)
	}
}

func TestPamReconciliationTransportResultRejectsMissingOrMalformedAcknowledgement(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{name: "missing route", status: http.StatusNotFound, body: `{"error":"not found"}`},
		{name: "non-200", status: http.StatusConflict, body: `{"error":"conflict"}`},
		{name: "malformed", status: http.StatusOK, body: `{"protocolVersion":`},
		{name: "missing acknowledgement", status: http.StatusOK, body: `{}`},
		{name: "wrong protocol", status: http.StatusOK, body: `{"protocolVersion":2,"classification":"applied"}`},
		{name: "unknown classification", status: http.StatusOK, body: `{"protocolVersion":1,"classification":"accepted"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			if _, err := newPamTransportHeartbeat(server.URL, server.Client()).submitPamReconciliationResult(context.Background(), testPamCommandID, testPamObservation(testPamObservationID)); err == nil {
				t.Fatal("expected acknowledgement error")
			}
		})
	}
}

func TestPamReconciliationTransportRefusesRedirects(t *testing.T) {
	var redirectedHits atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		redirectedHits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"protocolVersion": 1, "dispositions": []any{}})
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()

	_, err := newPamTransportHeartbeat(source.URL, source.Client()).resolvePamBindings(context.Background(), []pamBindingCandidate{{
		ObservationID: testPamObservationID,
		ActuationID:   "30000000-0000-4000-8000-000000000001",
		Generation:    3,
	}})
	if err == nil {
		t.Fatal("expected redirect refusal")
	}
	if redirectedHits.Load() != 0 {
		t.Fatalf("redirect destination received %d requests", redirectedHits.Load())
	}
}

func newPamControllerTestHeartbeat(t *testing.T, manager *fakePamLifetimeManager) *Heartbeat {
	t.Helper()
	h := &Heartbeat{
		config: &config.Config{
			HeartbeatIntervalSeconds: 3600,
		},
		pamLifetimeManager:             manager,
		pamReconciliationOutbox:        newPamReconciliationOutbox(filepath.Join(t.TempDir(), "outbox")),
		pamReconciliationStaged:        make(map[string]pamlifetime.Result),
		pamReconciliationStagedReasons: make(map[string]string),
		pamReconciliationBlocked:       make(map[string]struct{}),
		pamReconciliationWake:          make(chan struct{}, 1),
		stopChan:                       make(chan struct{}),
	}
	h.pamResolveBindingsFn = func(_ context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
		dispositions := make([]pamBindingDisposition, len(candidates))
		for i, candidate := range candidates {
			dispositions[i] = pamBindingDisposition{Status: pamBindingStatusUnresolved, ObservationID: candidate.ObservationID}
		}
		return dispositions, nil
	}
	h.pamSubmitResultFn = func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
		return pamResultAcknowledgement{}, errors.New("transport unavailable")
	}
	return h
}

func deterministicTestPamObservation(t *testing.T) pamlifetime.Result {
	t.Helper()
	observation := testPamObservation("")
	id, err := pamlifetime.ReconciliationObservationID(observation)
	if err != nil {
		t.Fatal(err)
	}
	observation.ObservationID = id
	return observation
}

func pendingPamEntries(t *testing.T, h *Heartbeat) pamReconciliationOutboxSnapshot {
	t.Helper()
	snapshot, err := h.pamReconciliationOutbox.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestPamReceivedObservationReadinessStateTable(t *testing.T) {
	for _, test := range []struct {
		name              string
		configure         func(*testing.T, *Heartbeat, pamlifetime.Result)
		wantLocalReady    bool
		wantReceivedReady bool
		wantProtocol      int
	}{
		{
			name:              "clean local and outbox",
			wantLocalReady:    true,
			wantReceivedReady: true,
			wantProtocol:      2,
		},
		{
			name: "pending received closes apply protocol",
			configure: func(t *testing.T, h *Heartbeat, observation pamlifetime.Result) {
				observation.State = pamlifetime.ResultReceived
				if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
					t.Fatal(err)
				}
			},
			wantLocalReady: true,
		},
		{
			name: "ordinary non-received pending stays non-blocking",
			configure: func(t *testing.T, h *Heartbeat, observation pamlifetime.Result) {
				if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
					t.Fatal(err)
				}
			},
			wantLocalReady:    true,
			wantReceivedReady: true,
			wantProtocol:      2,
		},
		{
			name: "non-received blocked closes apply only",
			configure: func(_ *testing.T, h *Heartbeat, observation pamlifetime.Result) {
				h.setPamReconciliationBlocked(observation.ObservationID, true)
			},
			wantLocalReady: true,
		},
		{
			name: "non-received quarantine closes apply only",
			configure: func(t *testing.T, h *Heartbeat, observation pamlifetime.Result) {
				if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
					t.Fatal(err)
				}
				if err := h.pamReconciliationOutbox.Quarantine(testPamCommandID, observation.ObservationID, "same_command_rejected"); err != nil {
					t.Fatal(err)
				}
			},
			wantLocalReady: true,
		},
		{
			name: "unreadable outbox closes apply only",
			configure: func(t *testing.T, h *Heartbeat, _ pamlifetime.Result) {
				if err := os.MkdirAll(h.pamReconciliationOutbox.pendingDir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(h.pamReconciliationOutbox.pendingDir, "corrupt.json"), []byte("not-json"), 0600); err != nil {
					t.Fatal(err)
				}
			},
			wantLocalReady: true,
		},
		{
			name: "local unresolved closes both",
			configure: func(_ *testing.T, h *Heartbeat, observation pamlifetime.Result) {
				h.pamReconciliationMu.Lock()
				h.pamReconciliationStaged[observation.ObservationID] = observation
				h.pamReconciliationStagedReasons[observation.ObservationID] = pamReconciliationReasonBindingUnresolved
				h.pamReconciliationMu.Unlock()
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
			h.pamVerificationAvailable.Store(true)
			h.setPamReconciliationManagerAvailable(true)
			observation := deterministicTestPamObservation(t)
			if test.configure != nil {
				test.configure(t, h, observation)
			}
			h.recomputePamReconciliationReadiness()
			if got := h.pamReconciled.Load(); got != test.wantLocalReady {
				t.Fatalf("pamReconciled=%v, want %v", got, test.wantLocalReady)
			}
			if got := h.pamReceivedObservationReady.Load(); got != test.wantReceivedReady {
				t.Fatalf("pamReceivedObservationReady=%v, want %v", got, test.wantReceivedReady)
			}
			if got := h.pamLifetimeProtocolVersion(); got != test.wantProtocol {
				t.Fatalf("protocol=%d, want %d", got, test.wantProtocol)
			}
		})
	}
}

func TestPamReceivedObservationReadinessFinalAcknowledgementReopensApply(t *testing.T) {
	h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
	h.pamVerificationAvailable.Store(true)
	h.setPamReconciliationManagerAvailable(true)
	observation := deterministicTestPamObservation(t)
	observation.State = pamlifetime.ResultReceived
	if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}
	h.recomputePamReconciliationReadiness()
	if h.pamReceivedObservationReady.Load() {
		t.Fatal("received readiness open before acknowledgement")
	}
	h.pamSubmitResultFn = func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
		return pamResultAcknowledgement{ProtocolVersion: 1, Classification: pamResultClassificationApplied}, nil
	}
	h.reconcilePamEvidence(context.Background())
	if !h.pamReconciled.Load() || !h.pamReceivedObservationReady.Load() || h.pamLifetimeProtocolVersion() != 2 {
		t.Fatalf("readiness after acknowledgement local=%v received=%v protocol=%d", h.pamReconciled.Load(), h.pamReceivedObservationReady.Load(), h.pamLifetimeProtocolVersion())
	}
}

func TestPamReceivedObservationReadinessBlocksApply(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyPamApplyTestHeartbeat(manager, newPamReconciliationOutbox(t.TempDir()))
	h.pamReceivedObservationReady.Store(false)

	result := handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
	if result.Status != "failed" || manager.receivedCalls != 0 || manager.applyCalls != 0 {
		t.Fatalf("result=%+v received calls=%d apply calls=%d", result, manager.receivedCalls, manager.applyCalls)
	}
}

func TestPamReconciliationControllerStagedStateTable(t *testing.T) {
	tests := []struct {
		name           string
		status         string
		resolverErr    error
		failEnqueue    bool
		wantPending    int
		wantReconciled bool
		secondPass     bool
	}{
		{name: "bound enqueue success", status: pamBindingStatusBound, wantPending: 1, wantReconciled: true},
		{name: "bound enqueue failure retained", status: pamBindingStatusBound, failEnqueue: true, wantReconciled: false, secondPass: true},
		{name: "duplicate disposed", status: pamBindingStatusDuplicate, wantReconciled: true},
		{name: "stale disposed", status: pamBindingStatusStale, wantReconciled: true},
		{name: "unresolved retained", status: pamBindingStatusUnresolved, wantReconciled: false, secondPass: true},
		{name: "resolver failure retained", resolverErr: errors.New("resolver unavailable"), wantReconciled: false, secondPass: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			observation := testPamObservation("")
			manager := &fakePamLifetimeManager{available: true, reconcileResults: []pamlifetime.Result{observation}}
			h := newPamControllerTestHeartbeat(t, manager)
			status := test.status
			resolverErr := test.resolverErr
			h.pamResolveBindingsFn = func(_ context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
				if resolverErr != nil {
					return nil, resolverErr
				}
				disposition := pamBindingDisposition{Status: status, ObservationID: candidates[0].ObservationID}
				if status == pamBindingStatusBound {
					disposition.CommandID = testPamCommandID
				}
				return []pamBindingDisposition{disposition}, nil
			}
			originalWrite := h.pamReconciliationOutbox.writeFn
			if test.failEnqueue {
				h.pamReconciliationOutbox.writeFn = func(*os.File, []byte) error { return errors.New("disk full") }
			}

			results := h.ReconcilePAMLifetime(context.Background())
			if len(results) != 1 || results[0].ObservationID == "" {
				t.Fatalf("reconcile results = %+v", results)
			}
			snapshot := pendingPamEntries(t, h)
			if len(snapshot.Pending) != test.wantPending {
				t.Fatalf("pending = %d, want %d", len(snapshot.Pending), test.wantPending)
			}
			if got := h.pamReconciled.Load(); got != test.wantReconciled {
				t.Fatalf("pamReconciled = %v, want %v", got, test.wantReconciled)
			}

			if test.secondPass {
				h.pamReconciliationOutbox.writeFn = originalWrite
				resolverErr = nil
				status = pamBindingStatusBound
				h.reconcilePamEvidence(context.Background())
				snapshot = pendingPamEntries(t, h)
				if len(snapshot.Pending) != 1 {
					t.Fatalf("retained staged observation was not durably handed off: %+v", snapshot)
				}
				if !h.pamReconciled.Load() {
					t.Fatal("admission stayed closed after retained observation was durably handed off")
				}
			}
		})
	}
}

func TestPamReconciliationControllerAcknowledgedPendingStateTable(t *testing.T) {
	for _, classification := range []string{
		pamResultClassificationApplied,
		pamResultClassificationDuplicate,
		pamResultClassificationStale,
	} {
		t.Run(classification, func(t *testing.T) {
			manager := &fakePamLifetimeManager{available: true}
			h := newPamControllerTestHeartbeat(t, manager)
			observation := deterministicTestPamObservation(t)
			if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
				t.Fatal(err)
			}
			h.pamSubmitResultFn = func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
				return pamResultAcknowledgement{ProtocolVersion: 1, Classification: classification}, nil
			}

			h.ReconcilePAMLifetime(context.Background())
			if snapshot := pendingPamEntries(t, h); len(snapshot.Pending) != 0 {
				t.Fatalf("acknowledged pending entry remains: %+v", snapshot)
			}
			if !h.pamReconciled.Load() {
				t.Fatal("admission closed after authoritative acknowledgement")
			}
		})
	}
}

func TestPamReconciliationControllerRejectedReresolutionStateTable(t *testing.T) {
	tests := []struct {
		name              string
		status            string
		commandID         string
		wantPending       int
		wantQuarantined   int
		wantReconciled    bool
		secondSubmitClass string
		failTransition    bool
	}{
		{name: "stale disposes", status: pamBindingStatusStale, wantReconciled: true},
		{name: "duplicate disposes", status: pamBindingStatusDuplicate, wantReconciled: true},
		{name: "unresolved retains and blocks", status: pamBindingStatusUnresolved, wantPending: 1, wantReconciled: true},
		{name: "same bound quarantines", status: pamBindingStatusBound, commandID: testPamCommandID, wantQuarantined: 1, wantReconciled: true},
		{name: "different bound rebinds and retries", status: pamBindingStatusBound, commandID: testPamNewCommandID, wantReconciled: true, secondSubmitClass: pamResultClassificationApplied},
		{name: "same bound quarantine failure blocks", status: pamBindingStatusBound, commandID: testPamCommandID, wantPending: 1, wantReconciled: true, failTransition: true},
		{name: "different bound rebind failure blocks", status: pamBindingStatusBound, commandID: testPamNewCommandID, wantPending: 1, wantReconciled: true, failTransition: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manager := &fakePamLifetimeManager{available: true}
			h := newPamControllerTestHeartbeat(t, manager)
			observation := deterministicTestPamObservation(t)
			if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
				t.Fatal(err)
			}
			h.pamSubmitResultFn = func(_ context.Context, commandID string, _ pamlifetime.Result) (pamResultAcknowledgement, error) {
				classification := pamResultClassificationRejected
				if commandID == testPamNewCommandID && test.secondSubmitClass != "" {
					classification = test.secondSubmitClass
				}
				return pamResultAcknowledgement{ProtocolVersion: 1, Classification: classification}, nil
			}
			h.pamResolveBindingsFn = func(_ context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
				return []pamBindingDisposition{{Status: test.status, ObservationID: candidates[0].ObservationID, CommandID: test.commandID}}, nil
			}
			if test.failTransition {
				h.pamReconciliationOutbox.renameFn = func(_, _ string) error { return errors.New("transition persistence failed") }
			}

			h.ReconcilePAMLifetime(context.Background())
			snapshot := pendingPamEntries(t, h)
			if len(snapshot.Pending) != test.wantPending || len(snapshot.Quarantined) != test.wantQuarantined {
				t.Fatalf("snapshot = %+v", snapshot)
			}
			if got := h.pamReconciled.Load(); got != test.wantReconciled {
				t.Fatalf("pamReconciled = %v, want %v", got, test.wantReconciled)
			}
			wantReceivedReady := test.wantReconciled && test.wantPending == 0 && test.wantQuarantined == 0
			if got := h.pamReceivedObservationReady.Load(); got != wantReceivedReady {
				t.Fatalf("pamReceivedObservationReady = %v, want %v", got, wantReceivedReady)
			}
		})
	}
}

func TestPamReconciliationControllerStartupQuarantineReresolution(t *testing.T) {
	for _, test := range []struct {
		status         string
		wantQuarantine int
		wantReconciled bool
	}{
		{status: pamBindingStatusStale, wantReconciled: true},
		{status: pamBindingStatusDuplicate, wantReconciled: true},
		{status: pamBindingStatusBound, wantQuarantine: 1, wantReconciled: true},
	} {
		t.Run(test.status, func(t *testing.T) {
			h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
			observation := deterministicTestPamObservation(t)
			if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
				t.Fatal(err)
			}
			if err := h.pamReconciliationOutbox.Quarantine(testPamCommandID, observation.ObservationID, "same_command_rejected"); err != nil {
				t.Fatal(err)
			}
			h.pamResolveBindingsFn = func(_ context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
				disposition := pamBindingDisposition{Status: test.status, ObservationID: candidates[0].ObservationID}
				if test.status == pamBindingStatusBound {
					disposition.CommandID = testPamCommandID
				}
				return []pamBindingDisposition{disposition}, nil
			}

			h.ReconcilePAMLifetime(context.Background())
			snapshot := pendingPamEntries(t, h)
			if len(snapshot.Quarantined) != test.wantQuarantine {
				t.Fatalf("snapshot = %+v", snapshot)
			}
			if got := h.pamReconciled.Load(); got != test.wantReconciled {
				t.Fatalf("pamReconciled = %v, want %v", got, test.wantReconciled)
			}
			if got := h.pamReceivedObservationReady.Load(); got != (test.wantQuarantine == 0) {
				t.Fatalf("pamReceivedObservationReady = %v, quarantine=%d", got, test.wantQuarantine)
			}
		})
	}
}

func TestPamReconciliationControllerAwaitingAcknowledgementDoesNotBlockAdmission(t *testing.T) {
	h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
	observation := deterministicTestPamObservation(t)
	if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}

	h.ReconcilePAMLifetime(context.Background())
	if snapshot := pendingPamEntries(t, h); len(snapshot.Pending) != 1 {
		t.Fatalf("unacknowledged observation was lost: %+v", snapshot)
	}
	if !h.pamReconciled.Load() {
		t.Fatal("durable pending acknowledgement kept admission closed")
	}
}

func TestPamReconciliationControllerStartsOnlyOneRetryLoop(t *testing.T) {
	h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
	observation := deterministicTestPamObservation(t)
	if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}
	called := make(chan struct{}, 4)
	h.pamSubmitResultFn = func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
		called <- struct{}{}
		return pamResultAcknowledgement{}, errors.New("offline")
	}

	h.startPamReconciliationRetryLoop()
	h.startPamReconciliationRetryLoop()
	select {
	case <-called:
	case <-time.After(2 * time.Second):
		t.Fatal("retry loop did not run immediately")
	}
	select {
	case <-called:
		t.Fatal("multiple immediate retry loops started")
	case <-time.After(100 * time.Millisecond):
	}
	close(h.stopChan)
}

func TestPamReconciliationControllerRetryLoopCancelsInFlightTransportOnStop(t *testing.T) {
	h := newPamControllerTestHeartbeat(t, &fakePamLifetimeManager{available: true})
	observation := deterministicTestPamObservation(t)
	if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	finished := make(chan struct{})
	h.pamSubmitResultFn = func(ctx context.Context, _ string, _ pamlifetime.Result) (pamResultAcknowledgement, error) {
		close(started)
		<-ctx.Done()
		close(finished)
		return pamResultAcknowledgement{}, ctx.Err()
	}

	h.startPamReconciliationRetryLoop()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("retry transport did not start")
	}
	close(h.stopChan)
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight retry transport was not cancelled on stop")
	}
}
