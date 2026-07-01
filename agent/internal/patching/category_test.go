package patching

import "testing"

func TestClassifyWindowsUpdateCategory(t *testing.T) {
	tests := []struct {
		name  string
		names []string
		want  string
	}{
		{"empty", nil, "application"},
		{"unknown only", []string{"Windows 11"}, "application"},
		{"security classification", []string{"Security Updates"}, "security"},
		{"critical is security", []string{"Critical Updates"}, "security"},
		{"driver", []string{"Drivers"}, "driver"},
		{"firmware", []string{"Firmware"}, "firmware"},
		{"definition (singular WUA name) -> definitions", []string{"Definition Updates"}, "definitions"},
		{"feature", []string{"Feature Packs"}, "feature"},
		{"service pack -> system", []string{"Service Packs"}, "system"},
		{"update rollup -> system", []string{"Update Rollups"}, "system"},
		// The core fix: product name first, real classification second — must NOT
		// land on "application".
		{"product name then security", []string{"Windows 11", "Security Updates"}, "security"},
		{"product name then driver", []string{"Windows 10", "Drivers"}, "driver"},
		// Specificity ordering: security outranks driver when both present.
		{"security beats driver", []string{"Drivers", "Security Updates"}, "security"},
		// firmware outranks driver when both present.
		{"firmware beats driver", []string{"Drivers", "Firmware"}, "firmware"},
		{"case insensitive", []string{"SECURITY UPDATES"}, "security"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyWindowsUpdateCategory(tt.names); got != tt.want {
				t.Errorf("classifyWindowsUpdateCategory(%q) = %q, want %q", tt.names, got, tt.want)
			}
		})
	}
}
