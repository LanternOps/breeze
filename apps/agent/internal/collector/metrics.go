package collector

import (
	"fmt"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/pkg/models"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	psnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
	"go.uber.org/zap"
)

// MetricsCollector collects real-time system metrics including
// CPU utilization, memory usage, disk I/O, and network I/O.
type MetricsCollector struct {
	BaseCollector
	// cpuInterval is the duration to wait when measuring CPU percentage
	cpuInterval time.Duration
}

// NewMetricsCollector creates a new MetricsCollector with the given logger
func NewMetricsCollector(logger *zap.Logger) *MetricsCollector {
	return &MetricsCollector{
		BaseCollector: NewBaseCollector(logger),
		cpuInterval:   time.Second, // 1 second interval for CPU measurement
	}
}

// Name returns the collector's name
func (m *MetricsCollector) Name() string {
	return "metrics"
}

// Collect gathers real-time system metrics and returns models.Metrics.
// It collects CPU utilization (overall and per-core), memory utilization,
// disk I/O, and network I/O.
// Partial failures are logged as warnings but don't prevent other data collection.
func (m *MetricsCollector) Collect() (interface{}, error) {
	m.LogDebug("Starting metrics collection")

	metrics := models.Metrics{
		Timestamp: time.Now().UTC(),
	}
	var collectionErrors []string

	// Collect CPU metrics
	cpuMetrics, err := m.collectCPUMetrics()
	if err != nil {
		m.LogWarning("Failed to collect CPU metrics", zap.Error(err))
		collectionErrors = append(collectionErrors, fmt.Sprintf("CPU: %v", err))
	} else {
		metrics.CPU = cpuMetrics
	}

	// Collect memory metrics
	memMetrics, err := m.collectMemoryMetrics()
	if err != nil {
		m.LogWarning("Failed to collect memory metrics", zap.Error(err))
		collectionErrors = append(collectionErrors, fmt.Sprintf("Memory: %v", err))
	} else {
		metrics.Memory = memMetrics
	}

	// Collect disk I/O metrics
	diskMetrics, err := m.collectDiskMetrics()
	if err != nil {
		m.LogWarning("Failed to collect disk metrics", zap.Error(err))
		collectionErrors = append(collectionErrors, fmt.Sprintf("Disk: %v", err))
	} else {
		metrics.Disks = diskMetrics
	}

	// Collect network I/O metrics
	netMetrics, err := m.collectNetworkMetrics()
	if err != nil {
		m.LogWarning("Failed to collect network metrics", zap.Error(err))
		collectionErrors = append(collectionErrors, fmt.Sprintf("Network: %v", err))
	} else {
		metrics.Network = netMetrics
	}

	// Collect process count
	processCount, err := m.collectProcessCount()
	if err != nil {
		m.LogWarning("Failed to collect process count", zap.Error(err))
	} else {
		metrics.Processes = processCount
	}

	// Collect load average (Unix-like systems only)
	loadAvg, err := m.collectLoadAverage()
	if err != nil {
		m.LogWarning("Failed to collect load average", zap.Error(err))
	} else {
		metrics.LoadAvg = loadAvg
	}

	m.LogDebug("Metrics collection completed",
		zap.Float64("cpuUsed", metrics.CPU.UsedPct),
		zap.Float64("memUsed", metrics.Memory.UsedPct),
		zap.Int("errors", len(collectionErrors)))

	// Return error only if all collections failed
	if len(collectionErrors) == 4 {
		return metrics, fmt.Errorf("all metrics collectors failed: %v", collectionErrors)
	}

	return metrics, nil
}

// collectCPUMetrics gathers CPU utilization metrics
func (m *MetricsCollector) collectCPUMetrics() (models.CPUMetrics, error) {
	cpuMetrics := models.CPUMetrics{}

	// Get overall CPU percentage (this blocks for cpuInterval)
	percentages, err := cpu.Percent(m.cpuInterval, false)
	if err != nil {
		return cpuMetrics, fmt.Errorf("failed to get CPU percentage: %w", err)
	}
	if len(percentages) > 0 {
		cpuMetrics.UsedPct = percentages[0]
	}

	// Get per-core CPU percentage
	perCorePercentages, err := cpu.Percent(0, true) // 0 duration = use cached value
	if err != nil {
		m.LogWarning("Failed to get per-core CPU percentages", zap.Error(err))
	} else {
		cpuMetrics.PerCore = perCorePercentages
	}

	// Get detailed CPU times for user/system/idle breakdown
	times, err := cpu.Times(false) // false = aggregate
	if err != nil {
		m.LogWarning("Failed to get CPU times", zap.Error(err))
	} else if len(times) > 0 {
		total := times[0].User + times[0].System + times[0].Idle + times[0].Nice +
			times[0].Iowait + times[0].Irq + times[0].Softirq + times[0].Steal
		if total > 0 {
			cpuMetrics.UserPct = (times[0].User / total) * 100
			cpuMetrics.SystemPct = (times[0].System / total) * 100
			cpuMetrics.IdlePct = (times[0].Idle / total) * 100
		}
	}

	return cpuMetrics, nil
}

// collectMemoryMetrics gathers memory utilization metrics
func (m *MetricsCollector) collectMemoryMetrics() (models.MemoryMetrics, error) {
	memMetrics := models.MemoryMetrics{}

	// Get virtual memory stats
	vmem, err := mem.VirtualMemory()
	if err != nil {
		return memMetrics, fmt.Errorf("failed to get memory stats: %w", err)
	}

	memMetrics.UsedPct = vmem.UsedPercent
	memMetrics.Available = vmem.Available

	// Get swap memory stats
	swap, err := mem.SwapMemory()
	if err != nil {
		m.LogWarning("Failed to get swap memory stats", zap.Error(err))
	} else if swap.Total > 0 {
		memMetrics.SwapUsedPct = swap.UsedPercent
	}

	return memMetrics, nil
}

// collectDiskMetrics gathers disk I/O metrics for all disks
func (m *MetricsCollector) collectDiskMetrics() ([]models.DiskMetrics, error) {
	var diskMetrics []models.DiskMetrics

	// Get disk I/O counters
	ioCounters, err := disk.IOCounters()
	if err != nil {
		m.LogWarning("Failed to get disk I/O counters", zap.Error(err))
	}

	// Get all partitions
	partitions, err := disk.Partitions(false)
	if err != nil {
		return diskMetrics, fmt.Errorf("failed to get disk partitions: %w", err)
	}

	// Track which devices we've seen to avoid duplicates
	seenDevices := make(map[string]bool)

	for _, partition := range partitions {
		// Skip pseudo filesystems
		if m.shouldSkipPartition(partition.Fstype) {
			continue
		}

		// Get the base device name (e.g., "sda" from "/dev/sda1")
		deviceName := getDeviceName(partition.Device)
		if seenDevices[deviceName] {
			continue
		}
		seenDevices[deviceName] = true

		dm := models.DiskMetrics{
			Device: partition.Device,
		}

		// Get usage percentage
		usage, err := disk.Usage(partition.Mountpoint)
		if err != nil {
			m.LogWarning("Failed to get disk usage",
				zap.String("device", partition.Device),
				zap.Error(err))
		} else {
			dm.UsedPct = usage.UsedPercent
		}

		// Get I/O counters for this device
		if ioCounters != nil {
			if counter, ok := ioCounters[deviceName]; ok {
				dm.ReadBytes = counter.ReadBytes
				dm.WriteBytes = counter.WriteBytes
				dm.ReadOps = counter.ReadCount
				dm.WriteOps = counter.WriteCount
			}
		}

		diskMetrics = append(diskMetrics, dm)
	}

	if len(diskMetrics) == 0 {
		return diskMetrics, fmt.Errorf("no disk metrics collected")
	}

	return diskMetrics, nil
}

// shouldSkipPartition returns true if the filesystem type should be skipped
func (m *MetricsCollector) shouldSkipPartition(fsType string) bool {
	skipTypes := map[string]bool{
		"devfs":       true,
		"devtmpfs":    true,
		"tmpfs":       true,
		"squashfs":    true,
		"overlay":     true,
		"aufs":        true,
		"proc":        true,
		"sysfs":       true,
		"cgroup":      true,
		"cgroup2":     true,
		"debugfs":     true,
		"securityfs":  true,
		"pstore":      true,
		"configfs":    true,
		"fusectl":     true,
		"mqueue":      true,
		"hugetlbfs":   true,
		"binfmt_misc": true,
	}
	return skipTypes[fsType]
}

// getDeviceName extracts the base device name from a device path
func getDeviceName(devicePath string) string {
	// Handle different device path formats
	// /dev/sda1 -> sda
	// /dev/nvme0n1p1 -> nvme0n1
	// C: -> C:

	switch runtime.GOOS {
	case "windows":
		return devicePath
	default:
		// For Unix-like systems, extract the base device name
		if len(devicePath) > 5 && devicePath[:5] == "/dev/" {
			name := devicePath[5:]
			// Remove partition number suffix for traditional devices
			for i := len(name) - 1; i >= 0; i-- {
				if name[i] < '0' || name[i] > '9' {
					// Check if this looks like a partition (ends with p followed by numbers for nvme)
					if name[i] == 'p' && i > 0 {
						// Check if it's nvme-style (nvme0n1p1)
						for j := 0; j < i; j++ {
							if name[j] == 'n' {
								return name[:i]
							}
						}
					}
					return name[:i+1]
				}
			}
			return name
		}
		return devicePath
	}
}

// collectNetworkMetrics gathers network I/O metrics (aggregate)
func (m *MetricsCollector) collectNetworkMetrics() (models.NetworkMetrics, error) {
	netMetrics := models.NetworkMetrics{}

	// Get network I/O counters for all interfaces
	ioCounters, err := psnet.IOCounters(false) // false = aggregate all interfaces
	if err != nil {
		return netMetrics, fmt.Errorf("failed to get network I/O counters: %w", err)
	}

	if len(ioCounters) > 0 {
		netMetrics.BytesSent = ioCounters[0].BytesSent
		netMetrics.BytesRecv = ioCounters[0].BytesRecv
		netMetrics.PacketsSent = ioCounters[0].PacketsSent
		netMetrics.PacketsRecv = ioCounters[0].PacketsRecv
		netMetrics.Errors = ioCounters[0].Errin + ioCounters[0].Errout
	}

	return netMetrics, nil
}

// collectProcessCount returns the number of running processes
func (m *MetricsCollector) collectProcessCount() (int, error) {
	pids, err := process.Pids()
	if err != nil {
		return 0, fmt.Errorf("failed to get process list: %w", err)
	}
	return len(pids), nil
}

// collectLoadAverage returns the system load average (Unix-like systems only)
func (m *MetricsCollector) collectLoadAverage() ([]float64, error) {
	// Load average is not available on Windows
	if runtime.GOOS == "windows" {
		return nil, nil
	}

	avg, err := load.Avg()
	if err != nil {
		return nil, fmt.Errorf("failed to get load average: %w", err)
	}

	return []float64{avg.Load1, avg.Load5, avg.Load15}, nil
}
