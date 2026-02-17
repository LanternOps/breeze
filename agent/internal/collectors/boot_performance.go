package collectors

import (
	"math"
	"sync"
	"time"
)

// BootPerformanceMetrics represents boot time data and startup item analysis
type BootPerformanceMetrics struct {
	BootTimestamp       time.Time     `json:"bootTimestamp"`
	BiosSeconds         float64       `json:"biosSeconds"`
	OsLoaderSeconds     float64       `json:"osLoaderSeconds"`
	DesktopReadySeconds float64       `json:"desktopReadySeconds"`
	TotalBootSeconds    float64       `json:"totalBootSeconds"`
	StartupItemCount    int           `json:"startupItemCount"`
	StartupItems        []StartupItem `json:"startupItems"`
}

// StartupItem represents a single startup/boot-time program or service
type StartupItem struct {
	Name        string  `json:"name"`
	Type        string  `json:"type"` // "service", "run_key", "startup_folder", "login_item", "launch_agent", "launch_daemon", "systemd", "cron", "init_d"
	Path        string  `json:"path"`
	Enabled     bool    `json:"enabled"`
	CpuTimeMs   int64   `json:"cpuTimeMs"`
	DiskIoBytes uint64  `json:"diskIoBytes"`
	ImpactScore float64 `json:"impactScore"`
}

// BootPerformanceCollector collects boot time metrics and startup item analysis.
// Platform-specific implementations are in boot_performance_*.go files.
type BootPerformanceCollector struct {
	collectedForBoot map[time.Time]bool
	mu               sync.RWMutex
}

// NewBootPerformanceCollector creates a new boot performance collector
func NewBootPerformanceCollector() *BootPerformanceCollector {
	return &BootPerformanceCollector{
		collectedForBoot: make(map[time.Time]bool),
	}
}

// MarkCollected marks a boot timestamp as already collected to prevent duplicates.
// It also prunes entries older than 24 hours to prevent unbounded map growth.
func (c *BootPerformanceCollector) MarkCollected(bootTime time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.collectedForBoot[bootTime] = true

	// Prune stale entries (boot times older than 24 hours)
	cutoff := time.Now().Add(-24 * time.Hour)
	for bt := range c.collectedForBoot {
		if bt.Before(cutoff) {
			delete(c.collectedForBoot, bt)
		}
	}
}

// HasCollected checks if boot performance has already been collected for the given boot time
func (c *BootPerformanceCollector) HasCollected(bootTime time.Time) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.collectedForBoot[bootTime]
}

// ShouldCollect returns true if we detect a recent boot that hasn't been collected yet.
// It checks if uptime is between 2 and 10 minutes (allowing services to settle) and
// we haven't already collected for this boot.
func (c *BootPerformanceCollector) ShouldCollect(uptimeSeconds int64, bootTime time.Time) bool {
	if uptimeSeconds > 600 { // More than 10 minutes
		return false
	}
	if uptimeSeconds < 120 { // Less than 2 minutes - too early, services still settling
		return false
	}
	return !c.HasCollected(bootTime)
}

// CalculateImpactScore computes a 0-100 impact score based on CPU time and disk I/O
func CalculateImpactScore(cpuTimeMs int64, diskIoBytes uint64) float64 {
	// Normalize CPU time (0-50 points, 10s = max)
	cpuScore := math.Min(float64(cpuTimeMs)/10000.0*50, 50)
	// Normalize disk I/O (0-50 points, 1GB = max)
	diskScore := math.Min(float64(diskIoBytes)/1073741824.0*50, 50)
	return math.Round((cpuScore+diskScore)*10) / 10
}

