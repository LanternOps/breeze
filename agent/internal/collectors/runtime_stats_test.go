package collectors

import (
	"encoding/json"
	"testing"
)

func TestCollectRuntimeStats(t *testing.T) {
	stats := CollectRuntimeStats()
	if stats == nil {
		t.Fatal("CollectRuntimeStats returned nil")
	}

	// A running Go process always has a non-empty heap and at least the
	// current goroutine.
	if stats.HeapAllocBytes == 0 {
		t.Error("HeapAllocBytes should be non-zero for a live process")
	}
	if stats.HeapInuseBytes == 0 {
		t.Error("HeapInuseBytes should be non-zero for a live process")
	}
	if stats.SysBytes == 0 {
		t.Error("SysBytes should be non-zero for a live process")
	}
	if stats.Goroutines < 1 {
		t.Errorf("Goroutines = %d, want >= 1", stats.Goroutines)
	}
	// HeapInuse counts whole spans, so it can never be below HeapAlloc.
	if stats.HeapInuseBytes < stats.HeapAllocBytes {
		t.Errorf("HeapInuseBytes (%d) < HeapAllocBytes (%d)", stats.HeapInuseBytes, stats.HeapAllocBytes)
	}
}

func TestRuntimeStatsJSONShape(t *testing.T) {
	// The wire field names are a contract with the API heartbeatSchema
	// (apps/api/src/routes/agents/schemas.ts agentRuntime) — renaming a JSON
	// key silently drops the gauge server-side.
	data, err := json.Marshal(CollectRuntimeStats())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{
		"heapAllocBytes", "heapInuseBytes", "heapReleasedBytes",
		"sysBytes", "numGc", "goroutines",
	} {
		if _, ok := m[key]; !ok {
			t.Errorf("expected JSON key %q missing", key)
		}
	}
}
