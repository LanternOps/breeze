package logging

import (
	"testing"
	"time"
)

// BenchmarkEnqueue measures the per-log hot path. Log-shipping health
// (#8610) must add no lock and no measurable cost here: health is recorded
// only at terminal chunk outcomes in shipChunk. No ship loop runs, so the
// buffer fills and the steady state is the full-buffer drop branch; the
// buffer is drained each time it fills so both branches are exercised.
func BenchmarkEnqueue(b *testing.B) {
	s := NewShipper(ShipperConfig{
		ServerURL: func() string { return "http://127.0.0.1:1" },
		AgentID:   "bench-agent",
	})
	entry := LogEntry{
		Timestamp: time.Now(),
		Level:     "info",
		Component: "bench",
		Message:   "benchmark log line",
		Fields:    map[string]any{"k": "v", "n": 1},
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.Enqueue(entry)
		if len(s.buffer) == cap(s.buffer) {
			b.StopTimer()
			for len(s.buffer) > 0 {
				<-s.buffer
			}
			b.StartTimer()
		}
	}
}
