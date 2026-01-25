package collectors

import (
	"net"
	"strings"

	"github.com/shirou/gopsutil/v3/disk"
	psnet "github.com/shirou/gopsutil/v3/net"
)

// DiskInfo represents a single disk drive
type DiskInfo struct {
	MountPoint  string  `json:"mountPoint"`
	Device      string  `json:"device"`
	FSType      string  `json:"fsType"`
	TotalGB     float64 `json:"totalGb"`
	UsedGB      float64 `json:"usedGb"`
	FreeGB      float64 `json:"freeGb"`
	UsedPercent float64 `json:"usedPercent"`
	Health      string  `json:"health"`
}

// NetworkAdapterInfo represents a network interface
type NetworkAdapterInfo struct {
	InterfaceName string `json:"interfaceName"`
	MACAddress    string `json:"macAddress"`
	IPAddress     string `json:"ipAddress"`
	IPType        string `json:"ipType"`
	IsPrimary     bool   `json:"isPrimary"`
}

// InventoryCollector collects disk and network inventory
type InventoryCollector struct{}

// NewInventoryCollector creates a new inventory collector
func NewInventoryCollector() *InventoryCollector {
	return &InventoryCollector{}
}

// CollectDisks collects information about all mounted disk drives
func (c *InventoryCollector) CollectDisks() ([]DiskInfo, error) {
	partitions, err := disk.Partitions(false)
	if err != nil {
		return nil, err
	}

	var disks []DiskInfo
	seen := make(map[string]bool)

	for _, partition := range partitions {
		// Skip duplicates and special filesystems
		if seen[partition.Mountpoint] {
			continue
		}
		if strings.HasPrefix(partition.Fstype, "squashfs") ||
			strings.HasPrefix(partition.Fstype, "tmpfs") ||
			strings.HasPrefix(partition.Fstype, "devfs") ||
			partition.Mountpoint == "" {
			continue
		}

		usage, err := disk.Usage(partition.Mountpoint)
		if err != nil {
			continue
		}

		// Skip very small partitions (< 100MB)
		if usage.Total < 100*1024*1024 {
			continue
		}

		seen[partition.Mountpoint] = true

		disks = append(disks, DiskInfo{
			MountPoint:  partition.Mountpoint,
			Device:      partition.Device,
			FSType:      partition.Fstype,
			TotalGB:     float64(usage.Total) / 1024 / 1024 / 1024,
			UsedGB:      float64(usage.Used) / 1024 / 1024 / 1024,
			FreeGB:      float64(usage.Free) / 1024 / 1024 / 1024,
			UsedPercent: usage.UsedPercent,
			Health:      "healthy",
		})
	}

	return disks, nil
}

// CollectNetworkAdapters collects information about network interfaces
func (c *InventoryCollector) CollectNetworkAdapters() ([]NetworkAdapterInfo, error) {
	interfaces, err := psnet.Interfaces()
	if err != nil {
		return nil, err
	}

	var adapters []NetworkAdapterInfo

	for _, iface := range interfaces {
		// Skip loopback and virtual interfaces
		if iface.Name == "lo" || iface.Name == "lo0" ||
			strings.HasPrefix(iface.Name, "veth") ||
			strings.HasPrefix(iface.Name, "docker") ||
			strings.HasPrefix(iface.Name, "br-") {
			continue
		}

		// Skip interfaces without MAC address (virtual interfaces)
		if iface.HardwareAddr == "" {
			continue
		}

		// Get the first IPv4 and IPv6 addresses
		var ipv4, ipv6 string
		for _, addr := range iface.Addrs {
			ip, _, err := net.ParseCIDR(addr.Addr)
			if err != nil {
				continue
			}
			if ip.To4() != nil && ipv4 == "" {
				ipv4 = ip.String()
			} else if ip.To4() == nil && ipv6 == "" {
				ipv6 = ip.String()
			}
		}

		// Add IPv4 entry if exists
		if ipv4 != "" {
			adapters = append(adapters, NetworkAdapterInfo{
				InterfaceName: iface.Name,
				MACAddress:    iface.HardwareAddr,
				IPAddress:     ipv4,
				IPType:        "ipv4",
				IsPrimary:     isPrimaryInterface(iface.Name),
			})
		}

		// Add IPv6 entry if exists (skip link-local)
		if ipv6 != "" && !strings.HasPrefix(ipv6, "fe80:") {
			adapters = append(adapters, NetworkAdapterInfo{
				InterfaceName: iface.Name,
				MACAddress:    iface.HardwareAddr,
				IPAddress:     ipv6,
				IPType:        "ipv6",
				IsPrimary:     false,
			})
		}
	}

	return adapters, nil
}

// isPrimaryInterface checks if an interface is likely the primary network interface
func isPrimaryInterface(name string) bool {
	// Common primary interface names across platforms
	primaryNames := []string{"en0", "eth0", "ens33", "enp0s3", "wlan0", "Wi-Fi", "Ethernet"}
	for _, primary := range primaryNames {
		if name == primary {
			return true
		}
	}
	return false
}
