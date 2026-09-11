package desktop

import "testing"

// chooseDPIAwareness must prefer per-monitor-v2 (physical coordinates on every
// monitor, matching DXGI output geometry), then per-monitor, then the legacy
// system-DPI call, and report which one took effect.
func TestChooseDPIAwareness(t *testing.T) {
	tests := []struct {
		name           string
		v2, pm, legacy bool
		want           string
	}{
		{"v2 available", true, true, true, dpiModePerMonitorV2},
		{"v2 missing, per-monitor available", false, true, true, dpiModePerMonitor},
		{"only legacy", false, false, true, dpiModeSystem},
		{"nothing works", false, false, false, dpiModeUnaware},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			calls := []string{}
			mk := func(name string, ok bool) func() bool {
				return func() bool { calls = append(calls, name); return ok }
			}
			got := chooseDPIAwareness(mk("v2", tc.v2), mk("pm", tc.pm), mk("legacy", tc.legacy))
			if got != tc.want {
				t.Fatalf("got %q want %q (calls %v)", got, tc.want, calls)
			}
			// Must stop at the first success — later calls fail with
			// ERROR_ACCESS_DENIED once the process mode is set.
			switch tc.want {
			case dpiModePerMonitorV2:
				if len(calls) != 1 {
					t.Fatalf("expected 1 call, got %v", calls)
				}
			case dpiModePerMonitor:
				if len(calls) != 2 {
					t.Fatalf("expected 2 calls, got %v", calls)
				}
			default:
				if len(calls) != 3 {
					t.Fatalf("expected every tier attempted (3 calls), got %v", calls)
				}
			}
		})
	}
}

func TestHresultSucceeded(t *testing.T) {
	cases := map[uintptr]bool{
		0x00000000: true,  // S_OK
		0x00000001: true,  // S_FALSE
		0x80070005: false, // E_ACCESSDENIED — mode already set; int64(hr) >= 0 would wrongly pass
		0x80070057: false, // E_INVALIDARG
	}
	for hr, want := range cases {
		if got := hresultSucceeded(hr); got != want {
			t.Errorf("0x%08x: got %v want %v", hr, got, want)
		}
	}
}
