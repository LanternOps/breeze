package collectors

import (
	"testing"
	"time"
)

func TestCalculateImpactScore(t *testing.T) {
	tests := []struct {
		name        string
		cpuTimeMs   int64
		diskIoBytes uint64
		wantMin     float64
		wantMax     float64
	}{
		{
			name:        "zero usage",
			cpuTimeMs:   0,
			diskIoBytes: 0,
			wantMin:     0,
			wantMax:     0,
		},
		{
			name:        "moderate CPU only",
			cpuTimeMs:   5000, // 5 seconds
			diskIoBytes: 0,
			wantMin:     24,
			wantMax:     26,
		},
		{
			name:        "moderate disk only",
			cpuTimeMs:   0,
			diskIoBytes: 500 * 1024 * 1024, // 500 MB
			wantMin:     24,
			wantMax:     25,
		},
		{
			name:        "max CPU",
			cpuTimeMs:   10000, // 10 seconds (cap)
			diskIoBytes: 0,
			wantMin:     50,
			wantMax:     50,
		},
		{
			name:        "max disk",
			cpuTimeMs:   0,
			diskIoBytes: 1024 * 1024 * 1024, // 1 GB (cap)
			wantMin:     50,
			wantMax:     50,
		},
		{
			name:        "max both",
			cpuTimeMs:   20000,                   // Over cap
			diskIoBytes: 2 * 1024 * 1024 * 1024, // Over cap
			wantMin:     100,
			wantMax:     100,
		},
		{
			name:        "small usage",
			cpuTimeMs:   100,
			diskIoBytes: 1024 * 1024, // 1 MB
			wantMin:     0,
			wantMax:     1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score := CalculateImpactScore(tt.cpuTimeMs, tt.diskIoBytes)
			if score < tt.wantMin || score > tt.wantMax {
				t.Errorf("CalculateImpactScore(%d, %d) = %f, want between %f and %f",
					tt.cpuTimeMs, tt.diskIoBytes, score, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestShouldCollect(t *testing.T) {
	collector := NewBootPerformanceCollector()
	bootTime := time.Now().Add(-5 * time.Minute)

	// Uptime > 10 minutes: should NOT collect
	if collector.ShouldCollect(700, bootTime) {
		t.Error("ShouldCollect should return false when uptime > 600s")
	}

	// Uptime < 2 minutes: should NOT collect (too early)
	if collector.ShouldCollect(60, bootTime) {
		t.Error("ShouldCollect should return false when uptime < 120s")
	}

	// Uptime in range (2-10 min), not collected: should collect
	if !collector.ShouldCollect(300, bootTime) {
		t.Error("ShouldCollect should return true when uptime is 300s and not collected")
	}

	// Mark as collected, then check again
	collector.MarkCollected(bootTime)
	if collector.ShouldCollect(300, bootTime) {
		t.Error("ShouldCollect should return false after MarkCollected")
	}
}

func TestMarkCollectedAndHasCollected(t *testing.T) {
	collector := NewBootPerformanceCollector()
	bootTime1 := time.Now().Add(-10 * time.Minute)
	bootTime2 := time.Now().Add(-5 * time.Minute)

	// Initially nothing is collected
	if collector.HasCollected(bootTime1) {
		t.Error("HasCollected should return false for uncollected boot time")
	}

	// Mark boot1 as collected
	collector.MarkCollected(bootTime1)
	if !collector.HasCollected(bootTime1) {
		t.Error("HasCollected should return true after MarkCollected")
	}

	// boot2 should still be uncollected
	if collector.HasCollected(bootTime2) {
		t.Error("HasCollected should return false for different boot time")
	}
}

func TestMarkCollectedPrunesStaleEntries(t *testing.T) {
	collector := NewBootPerformanceCollector()

	// Add an entry with a very old boot time (>24h ago)
	oldBoot := time.Now().Add(-48 * time.Hour)
	collector.mu.Lock()
	collector.collectedForBoot[oldBoot] = true
	collector.mu.Unlock()

	if !collector.HasCollected(oldBoot) {
		t.Fatal("setup: old boot should be present")
	}

	// Mark a recent boot - this should prune the old entry
	recentBoot := time.Now().Add(-5 * time.Minute)
	collector.MarkCollected(recentBoot)

	// Recent boot should be present
	if !collector.HasCollected(recentBoot) {
		t.Error("recent boot should be present after MarkCollected")
	}

	// Old boot should have been pruned
	if collector.HasCollected(oldBoot) {
		t.Error("old boot (>24h) should have been pruned by MarkCollected")
	}
}
