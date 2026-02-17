//go:build darwin

package collectors

import (
	"testing"
	"time"
)

func TestParsePsTime(t *testing.T) {
	tests := []struct {
		name string
		s    string
		want time.Duration
	}{
		{"MM:SS", "05:30", 5*time.Minute + 30*time.Second},
		{"HH:MM:SS", "01:05:30", time.Hour + 5*time.Minute + 30*time.Second},
		{"DD-HH:MM:SS", "3-04:05:06", 3*24*time.Hour + 4*time.Hour + 5*time.Minute + 6*time.Second},
		{"zero", "00:00", 0},
		{"seconds only", "00:45", 45 * time.Second},
		{"empty string", "", 0},
		{"whitespace", "  05:30  ", 5*time.Minute + 30*time.Second},
		{"invalid", "abc", 0},
		{"single part", "30", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parsePsTime(tt.s)
			if got != tt.want {
				t.Errorf("parsePsTime(%q) = %v, want %v", tt.s, got, tt.want)
			}
		})
	}
}

func TestEnrichItemsWithPerformance(t *testing.T) {
	items := []StartupItem{
		{Name: "com.apple.spotlight", Path: "/usr/libexec/mds_stores", Enabled: true},
		{Name: "com.apple.fseventsd", Path: "/usr/libexec/fseventsd", Enabled: true},
		{Name: "unmatched-service", Path: "/usr/bin/unmatched", Enabled: true},
	}

	procs := []processInfo{
		{comm: "mds_stores", cpuTimeMs: 500, elapsed: 10 * time.Second},
		{comm: "fseventsd", cpuTimeMs: 200, elapsed: 5 * time.Second},
	}

	enrichItemsWithPerformance(items, procs)

	// mds_stores should match by path base
	if items[0].CpuTimeMs != 500 {
		t.Errorf("items[0].CpuTimeMs = %d, want 500", items[0].CpuTimeMs)
	}
	if items[0].DiskIoBytes != 500*10240 {
		t.Errorf("items[0].DiskIoBytes = %d, want %d", items[0].DiskIoBytes, 500*10240)
	}
	if items[0].ImpactScore == 0 {
		t.Error("items[0].ImpactScore should be > 0")
	}

	// fseventsd should match
	if items[1].CpuTimeMs != 200 {
		t.Errorf("items[1].CpuTimeMs = %d, want 200", items[1].CpuTimeMs)
	}

	// unmatched should remain at zero
	if items[2].CpuTimeMs != 0 {
		t.Errorf("items[2].CpuTimeMs = %d, want 0", items[2].CpuTimeMs)
	}
}
