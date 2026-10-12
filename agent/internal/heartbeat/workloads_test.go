package heartbeat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/workloads"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

type fakeWorkloadsCollector struct {
	mu      sync.Mutex
	calls   int
	collect func(ctx context.Context, s workloads.Settings) *workloads.Report
}

func (f *fakeWorkloadsCollector) HasDrivers() bool { return true }
func (f *fakeWorkloadsCollector) Collect(ctx context.Context, s workloads.Settings) *workloads.Report {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return f.collect(ctx, s)
}

func workloadsReport(ids ...string) *workloads.Report {
	ws := []workloads.Workload{}
	for _, id := range ids {
		ws = append(ws, workloads.Workload{WorkloadID: id, Kind: workloads.KindContainer, Name: id, State: workloads.StateRunning})
	}
	return &workloads.Report{ProtocolVersion: 1, CollectedAt: "2026-10-06T12:00:00Z", Runtimes: []workloads.RuntimeReport{{
		Runtime: workloads.RuntimeDocker, Detection: workloads.DetectionPresent, Collection: workloads.CollectionOK,
		Complete: true, ObservedCount: len(ws), Workloads: ws,
	}}}
}

type workloadsTransport func(*http.Request) (*http.Response, error)

func (f workloadsTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type sentRequest struct {
	method, path, contentType string
	body                      []byte
}

// newWorkloadsHeartbeat wires a Heartbeat to a fake collector and a transport
// that records requests and answers with statuses[i] (200 once exhausted).
func newWorkloadsHeartbeat(t *testing.T, col *fakeWorkloadsCollector, statuses ...int) (*Heartbeat, *workloadsRuntime, *[]sentRequest) {
	t.Helper()
	cfg := config.Default()
	cfg.AgentID = "fixture-agent"
	cfg.ServerURL = "https://workloads.example.com"
	cfg.AuthToken = "fixture-token"
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r := &workloadsRuntime{col: col, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), settings: workloads.DefaultSettings()}
	h := &Heartbeat{config: cfg, agentVersion: "fixture-version", retryCfg: httputil.DefaultRetryConfig(), workloads: r}
	h.retryCfg.MaxRetries = 0
	var mu sync.Mutex
	var sent []sentRequest
	h.client = &http.Client{Transport: workloadsTransport(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		mu.Lock()
		sent = append(sent, sentRequest{req.Method, req.URL.Path, req.Header.Get("Content-Type"), body})
		n := len(sent)
		mu.Unlock()
		status := 200
		if n <= len(statuses) {
			status = statuses[n-1]
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"accepted":true}`))}, nil
	})}
	return h, r, &sent
}

func fixedCollector(ids ...string) *fakeWorkloadsCollector {
	return &fakeWorkloadsCollector{collect: func(context.Context, workloads.Settings) *workloads.Report { return workloadsReport(ids...) }}
}

func TestParseWorkloadSettings(t *testing.T) {
	good := func(m map[string]any) workloads.Settings {
		t.Helper()
		s, ok := parseWorkloadSettings(m)
		if !ok {
			t.Fatalf("rejected %v", m)
		}
		return s
	}
	snake := good(map[string]any{"enabled": true, "docker_enabled": true, "podman_enabled": false, "hyperv_enabled": true, "proxmox_enabled": false, "interval_minutes": 30.0})
	camel := good(map[string]any{"enabled": true, "dockerEnabled": true, "podmanEnabled": false, "hypervEnabled": true, "proxmoxEnabled": false, "intervalMinutes": 30})
	want := workloads.Settings{Enabled: true, Docker: true, Podman: false, HyperV: true, Proxmox: false, IntervalMinutes: 30}
	if snake != want || camel != want {
		t.Fatalf("snake=%+v camel=%+v want=%+v", snake, camel, want)
	}
	if s := good(map[string]any{"enabled": false, "interval_minutes": 60.0}); !s.Docker || !s.Podman || !s.HyperV || !s.Proxmox {
		t.Fatalf("missing runtime switches must default to true: %+v", s)
	}
	for name, m := range map[string]any{
		"not an object":      "x",
		"missing enabled":    map[string]any{"interval_minutes": 60.0},
		"enabled not bool":   map[string]any{"enabled": "yes", "interval_minutes": 60.0},
		"missing interval":   map[string]any{"enabled": true},
		"interval too small": map[string]any{"enabled": true, "interval_minutes": 14.0},
		"interval too large": map[string]any{"enabled": true, "interval_minutes": 1441.0},
		"fractional":         map[string]any{"enabled": true, "interval_minutes": 30.5},
		"interval string":    map[string]any{"enabled": true, "interval_minutes": "60"},
		"switch not bool":    map[string]any{"enabled": true, "interval_minutes": 60.0, "docker_enabled": "no"},
	} {
		if _, ok := parseWorkloadSettings(m); ok {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestApplyWorkloadInventoryConfig(t *testing.T) {
	h, r, _ := newWorkloadsHeartbeat(t, fixedCollector())
	if r.settings.Enabled {
		t.Fatal("collection must be off until a policy enables it")
	}
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 15.0})
	if !r.settings.Enabled || r.generation != 1 || len(r.wake) != 1 {
		t.Fatalf("settings=%+v generation=%d wake=%d", r.settings, r.generation, len(r.wake))
	}
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 15.0}) // identical
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": "garbage"})                      // invalid
	if r.generation != 1 || r.settings.IntervalMinutes != 15 {
		t.Fatalf("repeat or invalid payload changed state: generation=%d settings=%+v", r.generation, r.settings)
	}
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": false, "interval_minutes": 15.0})
	if r.settings.Enabled || r.generation != 2 {
		t.Fatalf("disable not applied: %+v generation=%d", r.settings, r.generation)
	}
}

// The key sits above the policy-probe early return in applyConfigUpdate; a
// heartbeat that carries only this key must still reach the handler.
func TestApplyConfigUpdateDispatchesWorkloadSettings(t *testing.T) {
	for _, key := range []string{"workload_inventory_settings", "workloadInventorySettings"} {
		h, r, _ := newWorkloadsHeartbeat(t, fixedCollector())
		h.applyConfigUpdate(map[string]any{key: map[string]any{"enabled": true, "interval_minutes": 60.0}})
		if !r.settings.Enabled {
			t.Fatalf("%s did not reach applyWorkloadInventoryConfig", key)
		}
	}
}

// The exact bytes the API puts in configUpdate (toWorkloadInventoryConfigUpdate
// in apps/api/src/services/workloads/configUpdate.ts), decoded the way a
// heartbeat response is. Every runtime flag is set opposite to its default so a
// renamed key cannot pass by falling back to the default.
func TestApplyConfigUpdateDecodesTheAPIWireShape(t *testing.T) {
	const wire = `{"workload_inventory_settings":{"enabled":true,"docker_enabled":false,"podman_enabled":false,"hyperv_enabled":false,"proxmox_enabled":false,"interval_minutes":15}}`
	var update map[string]any
	if err := json.Unmarshal([]byte(wire), &update); err != nil {
		t.Fatal(err)
	}
	h, r, _ := newWorkloadsHeartbeat(t, fixedCollector())
	h.applyConfigUpdate(update)
	want := workloads.Settings{Enabled: true, IntervalMinutes: 15}
	if r.settings != want {
		t.Fatalf("settings = %+v, want %+v", r.settings, want)
	}
}

func TestWorkloadsCycleSendsToTheContractEndpoint(t *testing.T) {
	h, r, sent := newWorkloadsHeartbeat(t, fixedCollector("a"))
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 60.0})
	next := h.workloadsCycle(r, time.Now())
	if len(*sent) != 1 {
		t.Fatalf("requests = %d", len(*sent))
	}
	req := (*sent)[0]
	if req.method != "PUT" || req.path != "/api/v1/agents/fixture-agent/workloads" || req.contentType != "application/json" {
		t.Fatalf("request = %+v", req)
	}
	var body map[string]any
	if err := json.Unmarshal(req.body, &body); err != nil {
		t.Fatal(err)
	}
	if body["protocolVersion"] != float64(1) || body["runtimes"] == nil {
		t.Fatalf("body = %s", req.body)
	}
	if next < 54*time.Minute || next > 66*time.Minute {
		t.Fatalf("next = %v, want 60 min +-10%%", next)
	}
}

func TestWorkloadsCycleIsChangeOnlyWithKeepalive(t *testing.T) {
	ids := []string{"a"}
	col := &fakeWorkloadsCollector{collect: func(context.Context, workloads.Settings) *workloads.Report { return workloadsReport(ids...) }}
	h, r, sent := newWorkloadsHeartbeat(t, col)
	now := time.Now()
	h.workloadsCycle(r, now)
	h.workloadsCycle(r, now.Add(time.Hour))
	if len(*sent) != 1 {
		t.Fatalf("unchanged report was resent: %d requests", len(*sent))
	}
	ids = []string{"a", "b"}
	h.workloadsCycle(r, now.Add(2*time.Hour))
	if len(*sent) != 2 {
		t.Fatalf("changed report not sent: %d requests", len(*sent))
	}
	h.workloadsCycle(r, now.Add(2*time.Hour+workloadsKeepalive-time.Minute))
	if len(*sent) != 2 {
		t.Fatal("keepalive fired early")
	}
	h.workloadsCycle(r, now.Add(2*time.Hour+workloadsKeepalive))
	if len(*sent) != 3 {
		t.Fatalf("keepalive not sent: %d requests", len(*sent))
	}
}

func TestWorkloadsFailedSendDoesNotAdvanceHash(t *testing.T) {
	h, r, sent := newWorkloadsHeartbeat(t, fixedCollector("a"), 503, 400)
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 1440.0})
	now := time.Now()
	next := h.workloadsCycle(r, now)
	if r.lastHash != "" || !r.lastSent.IsZero() {
		t.Fatal("hash advanced after a 503")
	}
	if next != workloadsRetryDelay {
		t.Fatalf("retry delay = %v, want %v even on a 24 h interval", next, workloadsRetryDelay)
	}
	h.workloadsCycle(r, now.Add(time.Minute)) // 400: permanent rejection, still not advanced
	if r.lastHash != "" || len(*sent) != 2 {
		t.Fatalf("hash=%q requests=%d after a 400", r.lastHash, len(*sent))
	}
	h.workloadsCycle(r, now.Add(2*time.Minute)) // 200
	if r.lastHash == "" || len(*sent) != 3 {
		t.Fatalf("hash=%q requests=%d after success", r.lastHash, len(*sent))
	}
	h.workloadsCycle(r, now.Add(3*time.Minute))
	if len(*sent) != 3 {
		t.Fatal("accepted report was resent")
	}
}

func TestWorkloadsSettingsChangeMidCollectionDiscardsResult(t *testing.T) {
	var h *Heartbeat
	changed := false
	col := &fakeWorkloadsCollector{}
	col.collect = func(_ context.Context, s workloads.Settings) *workloads.Report {
		if !changed {
			changed = true
			h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "docker_enabled": false, "interval_minutes": 60.0})
		}
		return workloadsReport("stale-under-old-settings")
	}
	var r *workloadsRuntime
	var sent *[]sentRequest
	h, r, sent = newWorkloadsHeartbeat(t, col)
	next := h.workloadsCycle(r, time.Now())
	if len(*sent) != 0 || r.lastHash != "" {
		t.Fatalf("a report made under stale settings was sent: %d requests", len(*sent))
	}
	if next != 0 {
		t.Fatalf("next = %v, want an immediate re-run", next)
	}
	h.workloadsCycle(r, time.Now())
	if len(*sent) != 1 || col.calls != 2 {
		t.Fatalf("re-run under new settings: requests=%d collects=%d", len(*sent), col.calls)
	}
}

func TestWorkloadsDisabledStateIsStillReported(t *testing.T) {
	col := &fakeWorkloadsCollector{collect: func(_ context.Context, s workloads.Settings) *workloads.Report {
		rep := workloadsReport()
		if !s.Enabled {
			rep.Runtimes[0].Collection = workloads.CollectionDisabled
		}
		return rep
	}}
	h, r, sent := newWorkloadsHeartbeat(t, col)
	h.workloadsCycle(r, time.Now()) // default settings: Enabled=false
	if len(*sent) != 1 || !strings.Contains(string((*sent)[0].body), `"collection":"disabled"`) {
		t.Fatalf("detection-only report not sent: %d requests", len(*sent))
	}
}

func TestWorkloadsNilReportSendsNothing(t *testing.T) {
	col := &fakeWorkloadsCollector{collect: func(context.Context, workloads.Settings) *workloads.Report { return nil }}
	h, r, sent := newWorkloadsHeartbeat(t, col)
	if next := h.workloadsCycle(r, time.Now()); next <= 0 || len(*sent) != 0 {
		t.Fatalf("next=%v requests=%d", next, len(*sent))
	}
}

func TestWorkloadsStopCancelsInFlightUpload(t *testing.T) {
	entered := make(chan struct{})
	h, r, _ := newWorkloadsHeartbeat(t, fixedCollector("a"))
	h.client = &http.Client{Transport: workloadsTransport(func(req *http.Request) (*http.Response, error) {
		close(entered)
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	h.inventoryWg.Add(1)
	go func() {
		defer h.inventoryWg.Done()
		h.workloadsCycle(r, time.Now())
	}()
	<-entered
	h.stopWorkloads()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("upload ignored shutdown")
	}
	if r.lastHash != "" {
		t.Fatal("cancelled upload advanced the hash")
	}
}

func TestWorkloadsLoopIsTrackedAndStops(t *testing.T) {
	h, r, _ := newWorkloadsHeartbeat(t, fixedCollector())
	h.startWorkloads()
	h.startWorkloads() // idempotent
	if !r.started {
		t.Fatal("not started")
	}
	h.stopWorkloads()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker goroutine leaked past stop")
	}
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 60.0})
	if r.settings.Enabled {
		t.Fatal("settings applied after stop")
	}
}

// A settings delivery must not defeat the first-run delay: it is coalesced into
// the first run, and only later changes wake the worker immediately.
func TestWorkloadsSettingsWakeDoesNotSkipTheFirstRunDelay(t *testing.T) {
	col := fixedCollector("a")
	h, r, _ := newWorkloadsHeartbeat(t, col)
	r.firstDelay = 400 * time.Millisecond
	h.startWorkloads()
	t.Cleanup(func() {
		h.stopWorkloads()
		h.inventoryWg.Wait()
	})
	calls := func() int { col.mu.Lock(); defer col.mu.Unlock(); return col.calls }

	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 60.0})
	time.Sleep(150 * time.Millisecond)
	if n := calls(); n != 0 {
		t.Fatalf("settings delivery started a collection %d times before the first-run delay", n)
	}
	waitUntilWorkloads(t, "first run after the delay", func() bool { return calls() == 1 })
	if !r.settings.Enabled {
		t.Fatal("first run must see the settings delivered before it")
	}

	// After the first run a change wakes the worker straight away (interval is 60 min).
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "docker_enabled": false, "interval_minutes": 60.0})
	waitUntilWorkloads(t, "immediate run after a later settings change", func() bool { return calls() >= 2 })
}

func waitUntilWorkloads(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestWorkloadsWithoutRuntimeIsInert(t *testing.T) {
	h := &Heartbeat{} // an OS with no drivers never builds the runtime
	h.startWorkloads()
	h.stopWorkloads()
	h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 60.0})
}

func TestWorkloadsScheduleBounds(t *testing.T) {
	d := workloadsFirstDelay("agent-1")
	if d < time.Minute || d > 2*time.Minute {
		t.Fatalf("first delay = %v", d)
	}
	if workloadsFirstDelay("agent-1") != d || workloadsFirstDelay("agent-2") == d {
		t.Log("first delay is deterministic per agent id (a collision between two ids is possible but unlikely)")
	}
	for i := 0; i < 50; i++ {
		got := workloadsInterval("agent-1", 15*time.Minute, time.Unix(int64(i), 0))
		if got < 13*time.Minute+30*time.Second || got > 16*time.Minute+30*time.Second {
			t.Fatalf("interval = %v", got)
		}
	}
}

func TestHeartbeatDeclaresWorkloadInventoryCapability(t *testing.T) {
	caps := compiledSecurityCapabilities()
	if caps.WorkloadInventoryProtocolVersion != 1 {
		t.Fatalf("WorkloadInventoryProtocolVersion = %d, want 1", caps.WorkloadInventoryProtocolVersion)
	}
	body, err := json.Marshal(HeartbeatPayload{SecurityCapabilities: caps})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		SecurityCapabilities map[string]any `json:"securityCapabilities"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if v, ok := decoded.SecurityCapabilities["workloadInventoryProtocolVersion"]; !ok || v != float64(1) {
		t.Fatalf("capabilities on the wire = %v", decoded.SecurityCapabilities)
	}
}

// A permanent rejection (a 4xx other than 401/408/429: schema mismatch, a server
// without the route, an agent not authorized) waits the full interval instead
// of re-collecting and re-uploading every retry period; transient failures
// keep the short retry.
func TestWorkloadsPermanentRejectionWaitsTheFullInterval(t *testing.T) {
	for _, tc := range []struct {
		status int
		retry  bool
	}{{400, false}, {401, true}, {404, false}, {403, false}, {413, false}, {408, true}, {429, true}, {500, true}, {503, true}} {
		h, r, _ := newWorkloadsHeartbeat(t, fixedCollector("a"), tc.status)
		h.applyWorkloadInventoryConfig(map[string]any{"enabled": true, "interval_minutes": 1440.0})
		next := h.workloadsCycle(r, time.Now())
		if r.lastHash != "" {
			t.Fatalf("status %d advanced the hash", tc.status)
		}
		if got := next == workloadsRetryDelay; got != tc.retry {
			t.Errorf("status %d: next = %v, want short retry %v", tc.status, next, tc.retry)
		}
	}
}
