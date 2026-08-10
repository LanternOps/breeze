package heartbeat

import "testing"

// count sizes a make([]net.IP, count) allocation from a command payload the
// API forwards unvalidated (payload is z.any()). A negative value panics the
// handler and a large one reserves arbitrary memory on the device, so the
// value has to be bounded before it reaches make().
func TestClampPingCount(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int
	}{
		{"negative would panic make()", -1, 1},
		{"large negative", -1 << 30, 1},
		{"zero yields no probes", 0, 1},
		{"one", 1, 1},
		{"default", 4, 4},
		{"at max", maxPingCount, maxPingCount},
		{"over max", maxPingCount + 1, maxPingCount},
		{"absurd allocation request", 1 << 30, maxPingCount},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := clampPingCount(tt.in)
			if got != tt.want {
				t.Errorf("clampPingCount(%d) = %d, want %d", tt.in, got, tt.want)
			}
			if got < 1 {
				t.Errorf("clampPingCount(%d) = %d, which would make a zero/negative allocation", tt.in, got)
			}
		})
	}
}
