package collectors

import (
	"regexp"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

type SystemMetrics struct {
	CPUPercent            float64 `json:"cpuPercent"`
	RAMPercent            float64 `json:"ramPercent"`
	RAMUsedMB             uint64  `json:"ramUsedMb"`
	DiskPercent           float64 `json:"diskPercent"`
	DiskUsedGB            float64 `json:"diskUsedGb"`
	DiskActivityAvailable bool    `json:"diskActivityAvailable,omitempty"`
	DiskReadBytes         uint64  `json:"diskReadBytes,omitempty"`
	DiskWriteBytes        uint64  `json:"diskWriteBytes,omitempty"`
	DiskReadBps           uint64  `json:"diskReadBps,omitempty"`
	DiskWriteBps          uint64  `json:"diskWriteBps,omitempty"`
	DiskReadOps           uint64  `json:"diskReadOps,omitempty"`
	DiskWriteOps          uint64  `json:"diskWriteOps,omitempty"`
	NetworkInBytes        uint64  `json:"networkInBytes,omitempty"`
	NetworkOutBytes       uint64  `json:"networkOutBytes,omitempty"`
	ProcessCount          int     `json:"processCount,omitempty"`

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

type diskSnapshot struct {
	readBytes  uint64
	writeBytes uint64
	readOps    uint64
	writeOps   uint64
}

type MetricsCollector struct {
	lastNetIn  uint64
	lastNetOut uint64
	lastTime   time.Time

	// per-interface tracking
	lastIface  map[string]ifaceSnapshot
	speedCache map[string]cachedSpeed
	lastDisk   map[string]diskSnapshot
}

const speedCacheTTL = 5 * time.Minute

var (
	macDiskPartitionPattern   = regexp.MustCompile(`^(disk\d+)s\d+$`)
	nvmeDiskPartitionPattern  = regexp.MustCompile(`^(nvme\d+n\d+)p\d+$`)
	mmcDiskPartitionPattern   = regexp.MustCompile(`^(mmcblk\d+)p\d+$`)
	raidDiskPartitionPattern  = regexp.MustCompile(`^(md\d+)p\d+$`)
	genericDiskPartitionRegex = regexp.MustCompile(`^([a-z]+)\d+$`)
)

func NewMetricsCollector() *MetricsCollector {
	return &MetricsCollector{
		lastIface:  make(map[string]ifaceSnapshot),
		speedCache: make(map[string]cachedSpeed),
		lastDisk:   make(map[string]diskSnapshot),
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

	// Elapsed time since last collection (shared by both aggregate and per-interface)
	elapsed := now.Sub(c.lastTime).Seconds()

	// Disk activity (cross-platform deltas/rates)
	c.collectDiskActivity(metrics, elapsed)

	// Network — aggregate totals (backward-compatible)
	netIO, err := net.IOCounters(false)
	if err == nil && len(netIO) > 0 {
		currentIn := netIO[0].BytesRecv
		currentOut := netIO[0].BytesSent

		if c.lastNetIn > 0 && elapsed > 1 && elapsed < 300 {
			if currentIn >= c.lastNetIn {
				metrics.NetworkInBytes = currentIn - c.lastNetIn
				metrics.BandwidthInBps = uint64(float64(metrics.NetworkInBytes) / elapsed)
			}
			if currentOut >= c.lastNetOut {
				metrics.NetworkOutBytes = currentOut - c.lastNetOut
				metrics.BandwidthOutBps = uint64(float64(metrics.NetworkOutBytes) / elapsed)
			}
		}

		c.lastNetIn = currentIn
		c.lastNetOut = currentOut
	}

	// Network — per-interface bandwidth
	perIface, err := net.IOCounters(true)
	if err == nil {
		hasHistory := !c.lastTime.IsZero() && elapsed > 1 && elapsed < 300
		seen := make(map[string]bool)

		for _, iface := range perIface {
			if skipInterface(iface.Name) {
				continue
			}
			seen[iface.Name] = true

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
						bw.InBytesPerS = uint64(float64(iface.BytesRecv-prev.bytesRecv) / elapsed)
					}
					if iface.BytesSent >= prev.bytesSent {
						bw.OutBytesPerS = uint64(float64(iface.BytesSent-prev.bytesSent) / elapsed)
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

		// Prune stale entries for interfaces no longer present
		for name := range c.lastIface {
			if !seen[name] {
				delete(c.lastIface, name)
				delete(c.speedCache, name)
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

func (c *MetricsCollector) collectDiskActivity(metrics *SystemMetrics, elapsed float64) {
	diskIO, err := disk.IOCounters()
	if err != nil || len(diskIO) == 0 {
		return
	}

	selected := selectDiskCounters(diskIO)
	if len(selected) == 0 {
		return
	}

	metrics.DiskActivityAvailable = true
	hasHistory := !c.lastTime.IsZero() && elapsed > 1 && elapsed < 300

	if hasHistory {
		readBytes, writeBytes, readOps, writeOps := calculateDiskDeltas(selected, c.lastDisk)
		metrics.DiskReadBytes = readBytes
		metrics.DiskWriteBytes = writeBytes
		metrics.DiskReadOps = readOps
		metrics.DiskWriteOps = writeOps
		if elapsed > 0 {
			metrics.DiskReadBps = uint64(float64(readBytes) / elapsed)
			metrics.DiskWriteBps = uint64(float64(writeBytes) / elapsed)
		}
	}

	nextSnapshot := make(map[string]diskSnapshot, len(selected))
	for name, stat := range selected {
		nextSnapshot[name] = diskSnapshot{
			readBytes:  stat.ReadBytes,
			writeBytes: stat.WriteBytes,
			readOps:    stat.ReadCount,
			writeOps:   stat.WriteCount,
		}
	}
	c.lastDisk = nextSnapshot
}

func calculateDiskDeltas(current map[string]disk.IOCountersStat, previous map[string]diskSnapshot) (uint64, uint64, uint64, uint64) {
	var totalReadBytes uint64
	var totalWriteBytes uint64
	var totalReadOps uint64
	var totalWriteOps uint64

	for name, stat := range current {
		prev, ok := previous[name]
		if !ok {
			continue
		}
		// Counter reset/overflow protection.
		if stat.ReadBytes < prev.readBytes || stat.WriteBytes < prev.writeBytes ||
			stat.ReadCount < prev.readOps || stat.WriteCount < prev.writeOps {
			continue
		}

		totalReadBytes += stat.ReadBytes - prev.readBytes
		totalWriteBytes += stat.WriteBytes - prev.writeBytes
		totalReadOps += stat.ReadCount - prev.readOps
		totalWriteOps += stat.WriteCount - prev.writeOps
	}

	return totalReadBytes, totalWriteBytes, totalReadOps, totalWriteOps
}

func selectDiskCounters(raw map[string]disk.IOCountersStat) map[string]disk.IOCountersStat {
	selected := make(map[string]disk.IOCountersStat)
	for name, stat := range raw {
		if skipDiskDevice(name) {
			continue
		}
		selected[name] = stat
	}

	for name := range selected {
		parent := diskParentName(name)
		if parent == "" {
			continue
		}
		for candidate := range selected {
			if strings.EqualFold(candidate, parent) {
				delete(selected, name)
				break
			}
		}
	}

	return selected
}

func diskParentName(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))

	if match := macDiskPartitionPattern.FindStringSubmatch(lower); len(match) == 2 {
		return match[1]
	}
	if match := nvmeDiskPartitionPattern.FindStringSubmatch(lower); len(match) == 2 {
		return match[1]
	}
	if match := mmcDiskPartitionPattern.FindStringSubmatch(lower); len(match) == 2 {
		return match[1]
	}
	if match := raidDiskPartitionPattern.FindStringSubmatch(lower); len(match) == 2 {
		return match[1]
	}
	if match := genericDiskPartitionRegex.FindStringSubmatch(lower); len(match) == 2 {
		return match[1]
	}

	return ""
}

func skipDiskDevice(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "" {
		return true
	}
	prefixes := []string{
		"loop", "ram", "zram", "fd", "sr", "nbd", "zd",
	}
	for _, p := range prefixes {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return false
}

// skipInterface returns true for virtual/loopback interfaces that shouldn't be tracked.
func skipInterface(name string) bool {
	if name == "lo" || name == "lo0" {
		return true
	}
	prefixes := []string{
		"veth", "docker", "br-", // Linux container/bridge
		"vEther", "isatap", "Teredo", // Windows virtual
	}
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}
