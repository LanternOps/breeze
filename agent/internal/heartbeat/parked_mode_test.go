package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/parked"
)

// #8318 D-1a: parked mode. These tests swap startParkedResume: no t.Parallel().

func parkedRefusal(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`{"error":"device_pending_assignment"}`))
}

// parkedTestHeartbeat is a minimal heartbeat wired to rs with a parked state
// whose observer is the heartbeat's own, and a captured resume.
func parkedTestHeartbeat(t *testing.T, rs *routeServer) (*Heartbeat, *parked.State, *resumeCapture) {
	t.Helper()
	h := newRecoveryMarkerTestHeartbeat(&config.Config{AgentID: "agent-1", ServerURL: rs.srv.URL, AuthToken: "t"})
	st := parked.New()
	h.SetParkedState(st)
	rc := &resumeCapture{}
	prev := startParkedResume
	startParkedResume = func(_ *Heartbeat, tasks []startupTask) {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		rc.calls++
		rc.tasks = nil
		for _, task := range tasks {
			rc.tasks = append(rc.tasks, task.name)
		}
	}
	t.Cleanup(func() { startParkedResume = prev })
	return h, st, rc
}

type resumeCapture struct {
	mu    sync.Mutex
	calls int
	tasks []string
}

func (rc *resumeCapture) snapshot() (int, []string) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.calls, append([]string(nil), rc.tasks...)
}

func beatBody(parked bool) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		resp := map[string]any{"commands": []any{}}
		if parked {
			resp["parked"] = true
		}
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func TestHeartbeatResponseParkedFlagParsing(t *testing.T) {
	cases := map[string]bool{
		`{"commands":[],"parked":true}`:  true,
		`{"commands":[],"parked":false}`: false,
		`{"commands":[]}`:                false,
		`{}`:                             false,
	}
	for body, want := range cases {
		var resp HeartbeatResponse
		if err := json.Unmarshal([]byte(body), &resp); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		if resp.Parked != want {
			t.Errorf("%s: Parked = %v, want %v", body, resp.Parked, want)
		}
	}
}

func TestParkedAllowsURLMirrorsTheServerAllowList(t *testing.T) {
	const base = "https://cp.example.com/api/v1/agents/agent-1/"
	allowed := []string{
		"heartbeat", "commands", "commands/0b9f7c1e-4f7e-4a55-9b39-2f0f9d1b8a10/result",
		"rotate-token", "rotate-token/confirm", "uninstall-intent", "rebind", "rebind-confirm",
		"attestation/challenge", "attestation/complete",
		"renew-cert", "renew-cert/challenge", "renew-cert/confirm",
	}
	refused := []string{
		"software", "hardware", "patches/pending", "patches/installed", "disks", "network",
		"sessions", "security/status", "security/recovery-keys", "process-sample", "reliability",
		"eventlogs", "boot-performance", "logs", "unifi-collectors", "management/posture",
		"commands/x/progress", "attestation", "attestation/other", "heartbeat/extra",
	}
	for _, r := range allowed {
		if !parkedAllowsURL(base + r) {
			t.Errorf("%s refused, want allowed", r)
		}
	}
	for _, r := range refused {
		if parkedAllowsURL(base + r) {
			t.Errorf("%s allowed, want refused", r)
		}
	}
	for _, u := range []string{
		"https://cp.example.com/api/v1/workspace/agent/crawl-config",
		"https://cp.example.com/api/v1/extensions/x/agents/agent-1/heartbeat",
		"::not a url",
	} {
		if parkedAllowsURL(u) {
			t.Errorf("%s allowed, want refused (not a core agent route)", u)
		}
	}
}

// Entering on a parked beat, leaving on the first full beat, one resume.
func TestParkedBeatEntersAndFullBeatLeavesAndResumes(t *testing.T) {
	rs := newRouteServer(t)
	const beat = "/api/v1/agents/agent-1/heartbeat"
	rs.answer(beat, beatBody(true))
	h, st, rc := parkedTestHeartbeat(t, rs)

	if !h.postHeartbeat(h.serverURL(), &HeartbeatPayload{Status: "ok"}) {
		t.Fatal("parked beat failed")
	}
	if !st.Parked() || !h.isParked() {
		t.Fatal("not parked after a parked beat")
	}
	// Further parked beats change nothing and resume nothing.
	h.postHeartbeat(h.serverURL(), &HeartbeatPayload{Status: "ok"})
	if calls, _ := rc.snapshot(); calls != 0 {
		t.Fatalf("resumed %d times while still parked", calls)
	}

	stale := time.Now().Add(-48 * time.Hour)
	h.mu.Lock()
	h.lastInventoryUpdate, h.lastHardwareUpdate, h.lastPatchUpdate = stale, stale, stale
	h.mu.Unlock()

	rs.answer(beat, beatBody(false))
	if !h.postHeartbeat(h.serverURL(), &HeartbeatPayload{Status: "ok"}) {
		t.Fatal("full beat failed")
	}
	if st.Parked() {
		t.Fatal("still parked after a full beat")
	}
	calls, tasks := rc.snapshot()
	if calls != 1 {
		t.Fatalf("resume calls = %d, want 1", calls)
	}
	want := map[string]bool{"inventory": true, "hardware inventory": true, "patch inventory": true}
	for _, name := range tasks {
		delete(want, name)
	}
	if len(want) != 0 {
		t.Fatalf("resume tasks %v miss %v", tasks, want)
	}
	// The cadence gates the resume covers are stamped, so the tick that
	// follows does not send them a second time.
	h.mu.Lock()
	defer h.mu.Unlock()
	for name, ts := range map[string]time.Time{"inventory": h.lastInventoryUpdate, "hardware": h.lastHardwareUpdate, "patch": h.lastPatchUpdate} {
		if time.Since(ts) > time.Minute {
			t.Errorf("%s gate not stamped by the resume (%v)", name, ts)
		}
	}
}

// A server older than the field: no beat ever parks the agent and nothing
// resumes, exactly as before parked mode.
func TestOldServerBeatNeverParks(t *testing.T) {
	rs := newRouteServer(t)
	rs.answer("/api/v1/agents/agent-1/heartbeat", beatBody(false))
	h, st, rc := parkedTestHeartbeat(t, rs)
	for range 3 {
		if !h.postHeartbeat(h.serverURL(), &HeartbeatPayload{Status: "ok"}) {
			t.Fatal("beat failed")
		}
	}
	if st.Parked() {
		t.Fatal("parked by a server that never sent the field")
	}
	if calls, _ := rc.snapshot(); calls != 0 {
		t.Fatalf("resume ran %d times without any parked episode", calls)
	}
	if err := h.sendInventoryData("software", map[string]any{}, "software"); err != nil {
		t.Fatalf("inventory send against an old server = %v, want it to go out", err)
	}
}

// While parked, every refused route is skipped before the request; the
// allow-listed ones still go out.
func TestParkedSendersMakeNoRequest(t *testing.T) {
	rs := newRouteServer(t)
	h, st, _ := parkedTestHeartbeat(t, rs)
	st.ObserveBeat(true)

	if err := h.sendInventoryData("software", map[string]any{}, "software"); !errors.Is(err, ErrDeferred) {
		t.Fatalf("inventory send while parked = %v, want ErrDeferred", err)
	}
	h.sendProcessSample()
	h.sendBootPerformance(&collectors.BootPerformanceMetrics{})
	h.sendInventory()
	h.sendPatchInventory()

	var hwCollects atomic.Int32
	h.hardwareCollectFn = func() (*collectors.HardwareInfo, error) {
		hwCollects.Add(1)
		return &collectors.HardwareInfo{}, nil
	}
	h.sendHardwareInventory()
	if n := hwCollects.Load(); n != 0 {
		t.Fatalf("hardware collected %d times while parked, want 0", n)
	}
	h.inventoryWg.Wait()

	if n := rs.total.Load(); n != 0 {
		t.Fatalf("requests while parked = %d, want 0", n)
	}
	// The allow-list stays open: attestation and the heartbeat are ready.
	if !h.loopReady("POST", h.attestationURL("challenge")) {
		t.Fatal("attestation challenge refused while parked")
	}
	if !h.loopReady("POST", h.agentRouteURL("heartbeat")) {
		t.Fatal("heartbeat refused while parked")
	}

	// Assigned: the same sender goes out again.
	st.ObserveBeat(false)
	if err := h.sendInventoryData("software", map[string]any{}, "software"); err != nil {
		t.Fatalf("inventory send after assignment = %v", err)
	}
}

// The 403 fallback: a refusal on any route parks the agent at once, before
// the next beat, and the next send makes no request.
func TestParkedRefusalFallbackParks(t *testing.T) {
	rs := newRouteServer(t)
	const software = "/api/v1/agents/agent-1/software"
	rs.answer(software, parkedRefusal)
	h, st, _ := parkedTestHeartbeat(t, rs)

	if err := h.sendInventoryData("software", map[string]any{}, "software"); err == nil {
		t.Fatal("a refused send reported success")
	}
	if !st.Parked() {
		t.Fatal("a device_pending_assignment refusal did not park the agent")
	}
	if err := h.sendInventoryData("disks", map[string]any{}, "disks"); !errors.Is(err, ErrDeferred) {
		t.Fatalf("send after the refusal = %v, want ErrDeferred", err)
	}
	if n := rs.count("/api/v1/agents/agent-1/disks"); n != 0 {
		t.Fatalf("disks requests after parking = %d, want 0", n)
	}

	// A plain 403 (another refusal) parks nothing.
	rs2 := newRouteServer(t)
	rs2.answer(software, func(w http.ResponseWriter) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"tenant_offboarding"}`))
	})
	h2, st2, _ := parkedTestHeartbeat(t, rs2)
	_ = h2.sendInventoryData("software", map[string]any{}, "software")
	if st2.Parked() {
		t.Fatal("an unrelated 403 parked the agent")
	}
}

// Old server + fallback: the refusal parks, the next beat (no field) leaves
// and mutes the refusal, and later refusals no longer park: no flapping.
func TestParkedRefusalAgainstOldServerDoesNotFlap(t *testing.T) {
	rs := newRouteServer(t)
	const software = "/api/v1/agents/agent-1/software"
	rs.answer(software, parkedRefusal)
	rs.answer("/api/v1/agents/agent-1/heartbeat", beatBody(false))
	h, st, rc := parkedTestHeartbeat(t, rs)

	_ = h.sendInventoryData("software", map[string]any{}, "software")
	if !st.Parked() {
		t.Fatal("refusal did not park")
	}
	h.postHeartbeat(h.serverURL(), &HeartbeatPayload{Status: "ok"})
	if st.Parked() {
		t.Fatal("still parked after a beat without the field")
	}
	if calls, _ := rc.snapshot(); calls != 1 {
		t.Fatalf("resume calls = %d, want 1", calls)
	}
	for range 3 {
		_ = h.sendInventoryData("software", map[string]any{}, "software")
		h.postHeartbeat(h.serverURL(), &HeartbeatPayload{Status: "ok"})
	}
	if st.Parked() {
		t.Fatal("muted refusal parked again")
	}
	if calls, _ := rc.snapshot(); calls != 1 {
		t.Fatalf("resume calls after more refusals = %d, want still 1", calls)
	}
}

func TestParkedSelfRenewIsHourly(t *testing.T) {
	h := &Heartbeat{}
	now := time.Now()
	first, second := h.parkedSelfRenewAllowed(now), h.parkedSelfRenewAllowed(now)
	if !first || !second {
		t.Fatal("a heartbeat without a parked state must never throttle renewal")
	}
	h.parkedState = parked.New()
	h.parkedState.ObserveBeat(true)
	if !h.parkedSelfRenewAllowed(now) {
		t.Fatal("first parked renewal refused")
	}
	if h.parkedSelfRenewAllowed(now.Add(59 * time.Minute)) {
		t.Fatal("second parked renewal within the hour allowed")
	}
	if !h.parkedSelfRenewAllowed(now.Add(61 * time.Minute)) {
		t.Fatal("parked renewal after the hour refused")
	}
}

// The first hardware-health run waits while parked (its route is outside the
// allow-list), runs after the startup stagger once assigned, and gives up on
// shutdown.
func TestHardwareHealthFirstRunWaitsForAssignment(t *testing.T) {
	stagger := make(chan time.Time)
	var asked time.Duration
	after := func(d time.Duration) <-chan time.Time { asked = d; return stagger }
	half := func() float64 { return 0.5 }

	// Not parked: no wait, no stagger.
	h := &Heartbeat{parkedState: parked.New()}
	h.hwContext, h.hwCancel = context.WithCancel(context.Background())
	defer h.hwCancel()
	if !h.waitHardwareHealthUntilAssigned(half, after) {
		t.Fatal("an unparked device waited")
	}
	if asked != 0 {
		t.Fatalf("stagger asked for an unparked device (%v)", asked)
	}

	// Parked: blocks until assignment, then waits the stagger.
	h.parkedState.ObserveBeat(true)
	done := make(chan bool, 1)
	go func() { done <- h.waitHardwareHealthUntilAssigned(half, after) }()
	select {
	case <-done:
		t.Fatal("returned while still parked")
	case <-time.After(50 * time.Millisecond):
	}
	h.parkedState.ObserveBeat(false)
	stagger <- time.Now()
	if !<-done {
		t.Fatal("returned false after assignment")
	}
	if want := startupStaggerWindow / 2; asked != want {
		t.Fatalf("stagger = %v, want %v", asked, want)
	}

	// Shutdown while parked: returns false.
	h.parkedState.ObserveBeat(true)
	go func() { done <- h.waitHardwareHealthUntilAssigned(half, after) }()
	h.hwCancel()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("returned true on shutdown")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not return on shutdown")
	}
}
