package heartbeat

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/collectors"
)

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
	res := handleCapturePprof(nil, Command{ID: "c1", Type: "capture_pprof"})
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
	res := handleCapturePprof(nil, Command{
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
	res := handleCapturePprof(nil, Command{
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
	res := handleCapturePprof(nil, Command{
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

	res := handleCapturePprof(nil, Command{ID: "c5", Type: "capture_pprof"})
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed when profile exceeds size cap", res.Status)
	}
	if res.Error == "" {
		t.Error("expected size-cap error message")
	}
}

func TestHandleCapturePprofRejectsNonStringProfile(t *testing.T) {
	res := handleCapturePprof(nil, Command{
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
