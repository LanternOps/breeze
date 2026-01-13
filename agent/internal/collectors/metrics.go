package collectors

import (
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

type SystemMetrics struct {
	CPUPercent      float64 `json:"cpuPercent"`
	RAMPercent      float64 `json:"ramPercent"`
	RAMUsedMB       uint64  `json:"ramUsedMb"`
	DiskPercent     float64 `json:"diskPercent"`
	DiskUsedGB      float64 `json:"diskUsedGb"`
	NetworkInBytes  uint64  `json:"networkInBytes,omitempty"`
	NetworkOutBytes uint64  `json:"networkOutBytes,omitempty"`
	ProcessCount    int     `json:"processCount,omitempty"`
}

type MetricsCollector struct {
	lastNetIn  uint64
	lastNetOut uint64
}

func NewMetricsCollector() *MetricsCollector {
	return &MetricsCollector{}
}

func (c *MetricsCollector) Collect() (*SystemMetrics, error) {
	metrics := &SystemMetrics{}

	// CPU
	cpuPercent, err := cpu.Percent(0, false)
	if err == nil && len(cpuPercent) > 0 {
		metrics.CPUPercent = cpuPercent[0]
	}

	// Memory
	vmem, err := mem.VirtualMemory()
	if err == nil {
		metrics.RAMPercent = vmem.UsedPercent
		metrics.RAMUsedMB = vmem.Used / 1024 / 1024
	}

	// Disk (root partition)
	diskUsage, err := disk.Usage("/")
	if err == nil {
		metrics.DiskPercent = diskUsage.UsedPercent
		metrics.DiskUsedGB = float64(diskUsage.Used) / 1024 / 1024 / 1024
	}

	// Network
	netIO, err := net.IOCounters(false)
	if err == nil && len(netIO) > 0 {
		currentIn := netIO[0].BytesRecv
		currentOut := netIO[0].BytesSent

		if c.lastNetIn > 0 {
			metrics.NetworkInBytes = currentIn - c.lastNetIn
			metrics.NetworkOutBytes = currentOut - c.lastNetOut
		}

		c.lastNetIn = currentIn
		c.lastNetOut = currentOut
	}

	// Process count
	procs, err := process.Processes()
	if err == nil {
		metrics.ProcessCount = len(procs)
	}

	return metrics, nil
}
