package heartbeat

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
)

// newTestHeartbeatForDiag returns a zero-value Heartbeat for exercising
// handleCapturePprof and clears the package-level capture throttle so each
// test starts with a fresh rate-limit slot.
func newTestHeartbeatForDiag(t *testing.T) *Heartbeat {
	t.Helper()
	resetCapturePprofThrottle()
	t.Cleanup(resetCapturePprofThrottle)
	return &Heartbeat{}
}

// decodeDiagResult parses the JSON payload NewSuccessResult marshals into
// Stdout.
func decodeDiagResult(t *testing.T, stdout string) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("result stdout is not valid JSON: %v", err)
	}
	return result
}

// assertValidPprofBlob base64-decodes the named field and checks it looks
// like a debug=0 runtime/pprof profile (gzip-compressed protobuf, magic
// bytes 0x1f 0x8b).
func assertValidPprofBlob(t *testing.T, result map[string]any, field string) {
	t.Helper()
	b64, ok := result[field].(string)
	if !ok || b64 == "" {
		t.Fatalf("%s missing or not a string", field)
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("%s is not valid base64: %v", field, err)
	}
	if len(raw) < 2 || raw[0] != 0x1f || raw[1] != 0x8b {
		t.Fatalf("%s does not start with gzip magic bytes (got % x)", field, raw[:min(2, len(raw))])
	}
}

func TestHandleCapturePprofDefaultCapturesBoth(t *testing.T) {
	res := handleCapturePprof(newTestHeartbeatForDiag(t), Command{ID: "c1", Type: "capture_pprof"})
	if res.Status != "completed" {
		t.Fatalf("status = %q (error: %q), want completed", res.Status, res.Error)
	}
	result := decodeDiagResult(t, res.Stdout)
	assertValidPprofBlob(t, result, "heapProfileBase64")
	assertValidPprofBlob(t, result, "goroutineProfileBase64")

	if _, ok := result["capturedAt"].(string); !ok {
		t.Error("capturedAt missing")
	}
	rt, ok := result["runtime"].(map[string]any)
	if !ok {
		t.Fatal("runtime stats snapshot missing")
	}
	if goroutines, _ := rt["goroutines"].(float64); goroutines < 1 {
		t.Errorf("runtime.goroutines = %v, want >= 1", rt["goroutines"])
	}
}

func TestHandleCapturePprofHeapOnly(t *testing.T) {
	res := handleCapturePprof(newTestHeartbeatForDiag(t), Command{
		ID: "c2", Type: "capture_pprof",
		Payload: map[string]any{"profile": "heap"},
	})
	if res.Status != "completed" {
		t.Fatalf("status = %q (error: %q), want completed", res.Status, res.Error)
	}
	result := decodeDiagResult(t, res.Stdout)
	assertValidPprofBlob(t, result, "heapProfileBase64")
	if _, present := result["goroutineProfileBase64"]; present {
		t.Error("goroutineProfileBase64 should not be present for profile=heap")
	}
}

func TestHandleCapturePprofGoroutineOnly(t *testing.T) {
	res := handleCapturePprof(newTestHeartbeatForDiag(t), Command{
		ID: "c3", Type: "capture_pprof",
		Payload: map[string]any{"profile": "goroutine"},
	})
	if res.Status != "completed" {
		t.Fatalf("status = %q (error: %q), want completed", res.Status, res.Error)
	}
	result := decodeDiagResult(t, res.Stdout)
	assertValidPprofBlob(t, result, "goroutineProfileBase64")
	if _, present := result["heapProfileBase64"]; present {
		t.Error("heapProfileBase64 should not be present for profile=goroutine")
	}
}

func TestHandleCapturePprofRejectsUnknownProfile(t *testing.T) {
	res := handleCapturePprof(newTestHeartbeatForDiag(t), Command{
		ID: "c4", Type: "capture_pprof",
		Payload: map[string]any{"profile": "cpu"},
	})
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed for unknown profile", res.Status)
	}
	if res.Error == "" {
		t.Error("expected a descriptive error for an unknown profile")
	}
}

func TestHandleCapturePprofSizeCap(t *testing.T) {
	orig := maxProfileBytes
	maxProfileBytes = 1 // every real profile exceeds one byte
	defer func() { maxProfileBytes = orig }()

	res := handleCapturePprof(newTestHeartbeatForDiag(t), Command{ID: "c5", Type: "capture_pprof"})
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed when profile exceeds size cap", res.Status)
	}
	if res.Error == "" {
		t.Error("expected size-cap error message")
	}
}

func TestHandleCapturePprofRejectsNonStringProfile(t *testing.T) {
	res := handleCapturePprof(newTestHeartbeatForDiag(t), Command{
		ID: "c6", Type: "capture_pprof",
		Payload: map[string]any{"profile": 123},
	})
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed for non-string profile", res.Status)
	}
	if res.Error == "" {
		t.Error("expected a descriptive error for a non-string profile")
	}
}

// TestHandleCapturePprofIncludesWedgeGauges verifies the runtime snapshot in
// the capture result carries the worker-pool wedge gauges — i.e. that the
// handler goes through h.collectAgentRuntime, not the raw collector, which
// would report a permanently-plausible 0/0 (#2422).
func TestHandleCapturePprofIncludesWedgeGauges(t *testing.T) {
	h := newTestHeartbeatForDiag(t)
	// One command that started an hour ago with a 1s watchdog tier:
	// in flight AND overdue at capture time.
	key := h.trackInFlight(time.Now().Add(-time.Hour), time.Second)
	defer h.untrackInFlight(key)

	res := handleCapturePprof(h, Command{
		ID: "g1", Type: "capture_pprof",
		Payload: map[string]any{"profile": "goroutine"},
	})
	if res.Status != "completed" {
		t.Fatalf("status = %q (error: %q), want completed", res.Status, res.Error)
	}
	result := decodeDiagResult(t, res.Stdout)
	rt, ok := result["runtime"].(map[string]any)
	if !ok {
		t.Fatal("runtime stats snapshot missing")
	}
	if got, _ := rt["commandsInFlight"].(float64); got != 1 {
		t.Errorf("runtime.commandsInFlight = %v, want 1", rt["commandsInFlight"])
	}
	if got, _ := rt["commandsOverdue"].(float64); got != 1 {
		t.Errorf("runtime.commandsOverdue = %v, want 1", rt["commandsOverdue"])
	}
}

// TestHandleCapturePprofThrottled verifies back-to-back captures are
// rate-limited (each heap/all capture forces a stop-the-world GC) and that
// the slot frees up once the interval elapses.
func TestHandleCapturePprofThrottled(t *testing.T) {
	h := newTestHeartbeatForDiag(t)

	res := handleCapturePprof(h, Command{
		ID: "t1", Type: "capture_pprof",
		Payload: map[string]any{"profile": "goroutine"},
	})
	if res.Status != "completed" {
		t.Fatalf("first capture: status = %q (error: %q), want completed", res.Status, res.Error)
	}

	res = handleCapturePprof(h, Command{
		ID: "t2", Type: "capture_pprof",
		Payload: map[string]any{"profile": "goroutine"},
	})
	if res.Status != "failed" {
		t.Fatalf("second capture inside the interval: status = %q, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "rate-limited") {
		t.Errorf("rate-limit rejection error = %q, want it to mention rate-limited", res.Error)
	}

	// Shrink the interval below the elapsed time — the slot must free up.
	prev := setCapturePprofMinInterval(time.Nanosecond)
	t.Cleanup(func() { setCapturePprofMinInterval(prev) })
	time.Sleep(time.Millisecond)

	res = handleCapturePprof(h, Command{
		ID: "t3", Type: "capture_pprof",
		Payload: map[string]any{"profile": "goroutine"},
	})
	if res.Status != "completed" {
		t.Fatalf("capture after interval elapsed: status = %q (error: %q), want completed", res.Status, res.Error)
	}
}

// TestHandleCapturePprofValidationDoesNotConsumeSlot verifies a malformed
// payload is rejected without burning the capture rate-limit slot.
func TestHandleCapturePprofValidationDoesNotConsumeSlot(t *testing.T) {
	h := newTestHeartbeatForDiag(t)

	res := handleCapturePprof(h, Command{
		ID: "v1", Type: "capture_pprof",
		Payload: map[string]any{"profile": "cpu"},
	})
	if res.Status != "failed" {
		t.Fatalf("invalid profile: status = %q, want failed", res.Status)
	}

	res = handleCapturePprof(h, Command{
		ID: "v2", Type: "capture_pprof",
		Payload: map[string]any{"profile": "goroutine"},
	})
	if res.Status != "completed" {
		t.Fatalf("valid capture after validation failure: status = %q (error: %q), want completed", res.Status, res.Error)
	}
}

// TestHeartbeatPayloadAgentRuntimeWireKey pins the OUTER wire key of the
// runtime gauges. The API heartbeatSchema matches on the literal
// "agentRuntime" (apps/api/src/routes/agents/schemas.ts) with .optional(), so
// renaming the struct tag — or dropping the assignment in sendHeartbeat —
// would silently darken the gauges fleet-wide while every other test on both
// sides stayed green.
func TestHeartbeatPayloadAgentRuntimeWireKey(t *testing.T) {
	withStats, err := json.Marshal(HeartbeatPayload{
		Status:       "ok",
		AgentRuntime: collectors.CollectRuntimeStats(),
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(withStats, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := m["agentRuntime"]; !ok {
		t.Error(`payload with AgentRuntime set must serialize an "agentRuntime" key`)
	}

	withoutStats, err := json.Marshal(HeartbeatPayload{Status: "ok"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	m = map[string]any{}
	if err := json.Unmarshal(withoutStats, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := m["agentRuntime"]; ok {
		t.Error("nil AgentRuntime must be omitted (omitempty) so old-server compat is preserved")
	}
}
