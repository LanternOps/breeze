package collectors

import (
	"time"

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

	// Bandwidth: computed rates in bytes/sec
	BandwidthInBps  uint64               `json:"bandwidthInBps,omitempty"`
	BandwidthOutBps uint64               `json:"bandwidthOutBps,omitempty"`
	InterfaceStats  []InterfaceBandwidth `json:"interfaceStats,omitempty"`
}

// InterfaceBandwidth tracks per-interface bandwidth rates.
type InterfaceBandwidth struct {
	Name         string `json:"name"`
	InBytesPerS  uint64 `json:"inBytesPerSec"`
	OutBytesPerS uint64 `json:"outBytesPerSec"`
	InBytes      uint64 `json:"inBytes"`
	OutBytes     uint64 `json:"outBytes"`
	InPackets    uint64 `json:"inPackets"`
	OutPackets   uint64 `json:"outPackets"`
	InErrors     uint64 `json:"inErrors"`
	OutErrors    uint64 `json:"outErrors"`
	Speed        uint64 `json:"speed,omitempty"` // link speed in bits/sec, 0 if unknown
}

type ifaceSnapshot struct {
	bytesRecv   uint64
	bytesSent   uint64
	packetsRecv uint64
	packetsSent uint64
	errsIn      uint64
	errsOut     uint64
}

type cachedSpeed struct {
	speed uint64
	at    time.Time
}

type MetricsCollector struct {
	lastNetIn  uint64
	lastNetOut uint64
	lastTime   time.Time

	// per-interface tracking
	lastIface  map[string]ifaceSnapshot
	speedCache map[string]cachedSpeed
}

const speedCacheTTL = 5 * time.Minute

func NewMetricsCollector() *MetricsCollector {
	return &MetricsCollector{
		lastIface:  make(map[string]ifaceSnapshot),
		speedCache: make(map[string]cachedSpeed),
	}
}

func (c *MetricsCollector) getCachedLinkSpeed(ifaceName string) uint64 {
	if cached, ok := c.speedCache[ifaceName]; ok && time.Since(cached.at) < speedCacheTTL {
		return cached.speed
	}
	speed := getLinkSpeed(ifaceName)
	c.speedCache[ifaceName] = cachedSpeed{speed: speed, at: time.Now()}
	return speed
}

func (c *MetricsCollector) Collect() (*SystemMetrics, error) {
	metrics := &SystemMetrics{}
	now := time.Now()

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

	// Network — aggregate totals (backward-compatible)
	netIO, err := net.IOCounters(false)
	if err == nil && len(netIO) > 0 {
		currentIn := netIO[0].BytesRecv
		currentOut := netIO[0].BytesSent

		elapsed := now.Sub(c.lastTime).Seconds()
		if c.lastNetIn > 0 && currentIn >= c.lastNetIn && currentOut >= c.lastNetOut && elapsed > 1 && elapsed < 300 {
			metrics.NetworkInBytes = currentIn - c.lastNetIn
			metrics.NetworkOutBytes = currentOut - c.lastNetOut

			metrics.BandwidthInBps = uint64(float64(metrics.NetworkInBytes) / elapsed)
			metrics.BandwidthOutBps = uint64(float64(metrics.NetworkOutBytes) / elapsed)
		}

		c.lastNetIn = currentIn
		c.lastNetOut = currentOut
	}

	// Network — per-interface bandwidth
	perIface, err := net.IOCounters(true)
	if err == nil {
		ifaceElapsed := now.Sub(c.lastTime).Seconds()
		hasHistory := !c.lastTime.IsZero() && ifaceElapsed > 1 && ifaceElapsed < 300

		for _, iface := range perIface {
			if skipInterface(iface.Name) {
				continue
			}

			bw := InterfaceBandwidth{
				Name:       iface.Name,
				InBytes:    iface.BytesRecv,
				OutBytes:   iface.BytesSent,
				InPackets:  iface.PacketsRecv,
				OutPackets: iface.PacketsSent,
				InErrors:   iface.Errin,
				OutErrors:  iface.Errout,
			}

			if hasHistory {
				if prev, ok := c.lastIface[iface.Name]; ok {
					if iface.BytesRecv >= prev.bytesRecv {
						bw.InBytesPerS = uint64(float64(iface.BytesRecv-prev.bytesRecv) / ifaceElapsed)
					}
					if iface.BytesSent >= prev.bytesSent {
						bw.OutBytesPerS = uint64(float64(iface.BytesSent-prev.bytesSent) / ifaceElapsed)
					}
				}
			}

			bw.Speed = c.getCachedLinkSpeed(iface.Name)

			metrics.InterfaceStats = append(metrics.InterfaceStats, bw)

			c.lastIface[iface.Name] = ifaceSnapshot{
				bytesRecv:   iface.BytesRecv,
				bytesSent:   iface.BytesSent,
				packetsRecv: iface.PacketsRecv,
				packetsSent: iface.PacketsSent,
				errsIn:      iface.Errin,
				errsOut:     iface.Errout,
			}
		}
	}

	c.lastTime = now

	// Process count
	procs, err := process.Processes()
	if err == nil {
		metrics.ProcessCount = len(procs)
	}

	return metrics, nil
}

// skipInterface returns true for virtual/loopback interfaces that shouldn't be tracked.
func skipInterface(name string) bool {
	switch {
	case name == "lo" || name == "lo0":
		return true
	case len(name) >= 4 && name[:4] == "veth":
		return true
	case len(name) >= 6 && name[:6] == "docker":
		return true
	case len(name) >= 3 && name[:3] == "br-":
		return true
	// Windows virtual adapters
	case len(name) >= 6 && name[:6] == "vEther":
		return true
	case len(name) >= 8 && name[:8] == "isatap..":
		return true
	case len(name) >= 7 && name[:7] == "Teredo ":
		return true
	}
	return false
}
