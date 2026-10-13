package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/pamlifetime"
)

// PAM ownership epochs W4 (#8206): reconciliation binding protocol v2 adds the
// `retired` disposition. The agent asks for v2, falls back to v1 for the
// process lifetime when the server answers 400, and retires a ledger entry
// only through the manager's gated Retire capability.

const testPamV2ActuationID = "30000000-0000-4000-8000-000000000001"

func testPamV2Candidate() pamBindingCandidate {
	return pamBindingCandidate{ObservationID: testPamObservationID, ActuationID: testPamV2ActuationID, Generation: 3}
}

type pamBindingRequestRecord struct {
	ProtocolVersion int
	Count           int
}

// pamBindingServer answers each request with handler(version) and records
// the protocol version of every request.
func pamBindingServer(t *testing.T, handler func(version int, candidates []pamBindingCandidate) (int, any)) (*httptest.Server, func() []pamBindingRequestRecord) {
	t.Helper()
	var mu sync.Mutex
	var records []pamBindingRequestRecord
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ProtocolVersion int                   `json:"protocolVersion"`
			Candidates      []pamBindingCandidate `json:"candidates"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		mu.Lock()
		records = append(records, pamBindingRequestRecord{ProtocolVersion: request.ProtocolVersion, Count: len(request.Candidates)})
		mu.Unlock()
		status, body := handler(request.ProtocolVersion, request.Candidates)
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(server.Close)
	return server, func() []pamBindingRequestRecord {
		mu.Lock()
		defer mu.Unlock()
		return append([]pamBindingRequestRecord(nil), records...)
	}
}

func dispositionsFor(version int, status string, candidates []pamBindingCandidate) map[string]any {
	dispositions := make([]pamBindingDisposition, len(candidates))
	for i, candidate := range candidates {
		dispositions[i] = pamBindingDisposition{Status: status, ObservationID: candidate.ObservationID}
	}
	return map[string]any{"protocolVersion": version, "dispositions": dispositions}
}

func TestPamBindingResolverRequestsV2AndAcceptsRetired(t *testing.T) {
	server, records := pamBindingServer(t, func(version int, candidates []pamBindingCandidate) (int, any) {
		return http.StatusOK, dispositionsFor(version, pamBindingStatusRetired, candidates)
	})
	dispositions, err := newPamTransportHeartbeat(server.URL, server.Client()).resolvePamBindings(context.Background(), []pamBindingCandidate{testPamV2Candidate()})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(dispositions) != 1 || dispositions[0].Status != pamBindingStatusRetired {
		t.Fatalf("dispositions = %+v, want one retired", dispositions)
	}
	got := records()
	if len(got) != 1 || got[0].ProtocolVersion != 2 {
		t.Fatalf("requests = %+v, want a single v2 request", got)
	}
}

func TestPamBindingResolverFallsBackToV1OnBadRequestForProcessLifetime(t *testing.T) {
	server, records := pamBindingServer(t, func(version int, candidates []pamBindingCandidate) (int, any) {
		if version != 1 {
			return http.StatusBadRequest, map[string]any{"error": "invalid protocolVersion"}
		}
		return http.StatusOK, dispositionsFor(1, pamBindingStatusStale, candidates)
	})
	h := newPamTransportHeartbeat(server.URL, server.Client())
	for pass := 0; pass < 2; pass++ {
		dispositions, err := h.resolvePamBindings(context.Background(), []pamBindingCandidate{testPamV2Candidate()})
		if err != nil {
			t.Fatalf("pass %d: resolve: %v", pass, err)
		}
		if len(dispositions) != 1 || dispositions[0].Status != pamBindingStatusStale {
			t.Fatalf("pass %d: dispositions = %+v", pass, dispositions)
		}
	}
	got := records()
	want := []int{2, 1, 1}
	if len(got) != len(want) {
		t.Fatalf("requests = %+v, want versions %v", got, want)
	}
	for i := range want {
		if got[i].ProtocolVersion != want[i] {
			t.Fatalf("request %d version = %d, want %d (all: %+v)", i, got[i].ProtocolVersion, want[i], got)
		}
	}
}

func TestPamBindingResolverFallbackIsBounded(t *testing.T) {
	server, records := pamBindingServer(t, func(int, []pamBindingCandidate) (int, any) {
		return http.StatusBadRequest, map[string]any{"error": "bad request"}
	})
	h := newPamTransportHeartbeat(server.URL, server.Client())
	if _, err := h.resolvePamBindings(context.Background(), []pamBindingCandidate{testPamV2Candidate()}); err == nil {
		t.Fatal("expected an error when v1 is also refused")
	}
	if got := records(); len(got) != 2 {
		t.Fatalf("requests = %+v, want exactly one v2 and one v1 attempt", got)
	}
	// A 400 to v1 as well means the request, not the version, was refused:
	// the process must not give up on v2 (and on retirement) for it.
	if h.pamBindingProtocolVersion() != 2 {
		t.Fatal("fell back to v1 although v1 was refused too")
	}
}

func TestPamBindingResolverDoesNotFallBackOnOtherFailures(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusForbidden} {
		server, records := pamBindingServer(t, func(int, []pamBindingCandidate) (int, any) {
			return status, map[string]any{"error": "unavailable"}
		})
		h := newPamTransportHeartbeat(server.URL, server.Client())
		if _, err := h.resolvePamBindings(context.Background(), []pamBindingCandidate{testPamV2Candidate()}); err == nil {
			t.Fatalf("status %d: expected error", status)
		}
		for _, record := range records() {
			if record.ProtocolVersion != 2 {
				t.Fatalf("status %d: fell back to v%d", status, record.ProtocolVersion)
			}
		}
		if h.pamBindingProtocolVersion() != 2 {
			t.Fatalf("status %d: negotiated version dropped", status)
		}
	}
}

func TestPamBindingResolverRejectsRetiredOrMismatchedVersion(t *testing.T) {
	cases := []struct {
		name    string
		handler func(int, []pamBindingCandidate) (int, any)
	}{
		{"retired in a v1 response after fallback", func(version int, candidates []pamBindingCandidate) (int, any) {
			if version != 1 {
				return http.StatusBadRequest, map[string]any{"error": "bad request"}
			}
			return http.StatusOK, dispositionsFor(1, pamBindingStatusRetired, candidates)
		}},
		{"v1 response to a v2 request", func(_ int, candidates []pamBindingCandidate) (int, any) {
			return http.StatusOK, dispositionsFor(1, pamBindingStatusStale, candidates)
		}},
		{"unknown version", func(_ int, candidates []pamBindingCandidate) (int, any) {
			return http.StatusOK, dispositionsFor(3, pamBindingStatusStale, candidates)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, _ := pamBindingServer(t, tc.handler)
			h := newPamTransportHeartbeat(server.URL, server.Client())
			if _, err := h.resolvePamBindings(context.Background(), []pamBindingCandidate{testPamV2Candidate()}); err == nil {
				t.Fatal("expected resolver error")
			}
		})
	}
}

// retiringPamManager adds the optional Retire capability to the shared fake.
type retiringPamManager struct {
	*fakePamLifetimeManager
	mu        sync.Mutex
	retireErr error
	retired   []string
}

func (m *retiringPamManager) Retire(_ context.Context, actuationID string, generation uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.retireErr != nil {
		return m.retireErr
	}
	m.retired = append(m.retired, actuationID+"@"+itoaPam(generation))
	return nil
}

func itoaPam(v uint64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func retiredResolver(_ context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
	dispositions := make([]pamBindingDisposition, len(candidates))
	for i, candidate := range candidates {
		dispositions[i] = pamBindingDisposition{Status: pamBindingStatusRetired, ObservationID: candidate.ObservationID}
	}
	return dispositions, nil
}

func TestPamReconciliationRetiredDispositionRetiresLedgerEntry(t *testing.T) {
	observation := testPamObservation("")
	fake := &fakePamLifetimeManager{available: true, reconcileResults: []pamlifetime.Result{observation}}
	h := newPamControllerTestHeartbeat(t, fake)
	manager := &retiringPamManager{fakePamLifetimeManager: fake}
	h.pamLifetimeManager = manager
	h.pamResolveBindingsFn = retiredResolver

	h.ReconcilePAMLifetime(context.Background())

	manager.mu.Lock()
	retired := append([]string(nil), manager.retired...)
	manager.mu.Unlock()
	if len(retired) != 1 || retired[0] != observation.ActuationID+"@3" {
		t.Fatalf("retired = %v, want [%s@3]", retired, observation.ActuationID)
	}
	if len(h.stagedPamReconciliationResults()) != 0 {
		t.Fatal("retired observation is still staged")
	}
	if !h.pamReconciled.Load() {
		t.Fatal("admission stayed closed after the only entry was retired")
	}
	if snapshot := pendingPamEntries(t, h); len(snapshot.Pending) != 0 {
		t.Fatalf("retired observation reached the outbox: %+v", snapshot)
	}
}

func TestPamReconciliationRefusedRetirementStaysStagedAndClosed(t *testing.T) {
	observation := testPamObservation("")
	fake := &fakePamLifetimeManager{available: true, reconcileResults: []pamlifetime.Result{observation}}
	h := newPamControllerTestHeartbeat(t, fake)
	h.pamLifetimeManager = &retiringPamManager{fakePamLifetimeManager: fake, retireErr: errors.New("refusing to retire an entry with a live job")}
	h.pamResolveBindingsFn = retiredResolver

	h.ReconcilePAMLifetime(context.Background())

	if len(h.stagedPamReconciliationResults()) != 1 {
		t.Fatal("a refused retirement must keep the observation staged")
	}
	if h.pamReconciled.Load() {
		t.Fatal("admission opened although the retirement was refused")
	}
	if got := h.pamReconciliationStatus().BlockingReason; got != pamReconciliationReasonBindingUnresolved {
		t.Fatalf("blocking reason = %q, want %q", got, pamReconciliationReasonBindingUnresolved)
	}
}

func TestPamReconciliationRetiredWithoutCapabilityFailsClosed(t *testing.T) {
	observation := testPamObservation("")
	manager := &fakePamLifetimeManager{available: true, reconcileResults: []pamlifetime.Result{observation}}
	h := newPamControllerTestHeartbeat(t, manager)
	h.pamResolveBindingsFn = retiredResolver

	h.ReconcilePAMLifetime(context.Background())

	if len(h.stagedPamReconciliationResults()) != 1 || h.pamReconciled.Load() {
		t.Fatal("a manager without the Retire capability must keep the observation staged and admission closed")
	}
}

func TestPamReconciliationV1StaleLeavesLedgerAndOpensAdmission(t *testing.T) {
	observation := testPamObservation("")
	fake := &fakePamLifetimeManager{available: true, reconcileResults: []pamlifetime.Result{observation}}
	h := newPamControllerTestHeartbeat(t, fake)
	manager := &retiringPamManager{fakePamLifetimeManager: fake}
	h.pamLifetimeManager = manager
	h.pamResolveBindingsFn = func(_ context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
		return []pamBindingDisposition{{Status: pamBindingStatusStale, ObservationID: candidates[0].ObservationID}}, nil
	}

	h.ReconcilePAMLifetime(context.Background())

	if len(manager.retired) != 0 {
		t.Fatalf("stale must not retire the ledger entry, retired = %v", manager.retired)
	}
	if !h.pamReconciled.Load() {
		t.Fatal("stale must open admission")
	}
}

// A quarantined outbox entry the server now calls `retired` is dropped like
// `stale`; the ledger is retired only from the startup reconcile path.
func TestPamReconciliationRetiredQuarantinedEntryIsDroppedWithoutRetire(t *testing.T) {
	fake := &fakePamLifetimeManager{available: true}
	h := newPamControllerTestHeartbeat(t, fake)
	manager := &retiringPamManager{fakePamLifetimeManager: fake}
	h.pamLifetimeManager = manager
	observation := deterministicTestPamObservation(t)
	if err := h.pamReconciliationOutbox.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}
	if err := h.pamReconciliationOutbox.Quarantine(testPamCommandID, observation.ObservationID, "same_command_rejected"); err != nil {
		t.Fatal(err)
	}
	h.pamResolveBindingsFn = retiredResolver

	h.ReconcilePAMLifetime(context.Background())

	if snapshot := pendingPamEntries(t, h); len(snapshot.Quarantined) != 0 || len(snapshot.Pending) != 0 {
		t.Fatalf("retired quarantined entry kept: %+v", snapshot)
	}
	if len(manager.retired) != 0 {
		t.Fatalf("outbox path retired ledger entries: %v", manager.retired)
	}
	if !h.pamReconciled.Load() {
		t.Fatal("admission stayed closed after the quarantined entry was dropped")
	}
}

// The fallback holds across chunks: after chunk 1's v2 is refused and v1
// accepted, chunk 2 goes straight to v1.
func TestPamBindingResolverFallbackHoldsAcrossChunks(t *testing.T) {
	server, records := pamBindingServer(t, func(version int, candidates []pamBindingCandidate) (int, any) {
		if version != 1 {
			return http.StatusBadRequest, map[string]any{"error": "invalid protocolVersion"}
		}
		return http.StatusOK, dispositionsFor(1, pamBindingStatusStale, candidates)
	})
	candidates := make([]pamBindingCandidate, 150)
	for i := range candidates {
		candidates[i] = pamBindingCandidate{
			ObservationID: "20000000-0000-4000-8000-" + leftPad12(i+1),
			ActuationID:   testPamV2ActuationID,
			Generation:    uint64(i + 1),
		}
	}
	if _, err := newPamTransportHeartbeat(server.URL, server.Client()).resolvePamBindings(context.Background(), candidates); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	got := records()
	v2 := 0
	for _, record := range got {
		if record.ProtocolVersion == 2 {
			v2++
		}
	}
	if len(got) != 3 || v2 != 1 {
		t.Fatalf("requests = %+v, want one v2 then two v1", got)
	}
}

func leftPad12(n int) string {
	s := itoaPam(uint64(n))
	for len(s) < 12 {
		s = "0" + s
	}
	return s
}
