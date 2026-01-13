package collectors

import (
	"net"
)

type NetworkInterface struct {
	Name      string `json:"interfaceName"`
	MACAddr   string `json:"macAddress"`
	IPAddress string `json:"ipAddress,omitempty"`
	IPType    string `json:"ipType,omitempty"`
	IsPrimary bool   `json:"isPrimary"`
}

type NetworkCollector struct{}

func NewNetworkCollector() *NetworkCollector {
	return &NetworkCollector{}
}

func (c *NetworkCollector) Collect() ([]NetworkInterface, error) {
	var interfaces []NetworkInterface

	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}

	for _, iface := range ifaces {
		// Skip loopback and down interfaces
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}

		ni := NetworkInterface{
			Name:    iface.Name,
			MACAddr: iface.HardwareAddr.String(),
		}

		// Get IP addresses
		addrs, err := iface.Addrs()
		if err == nil {
			for _, addr := range addrs {
				if ipnet, ok := addr.(*net.IPNet); ok {
					if ipnet.IP.To4() != nil {
						ni.IPAddress = ipnet.IP.String()
						ni.IPType = "ipv4"
						break
					}
				}
			}
		}

		// Heuristic for primary interface
		if ni.IPAddress != "" && !isPrivateIP(ni.IPAddress) {
			ni.IsPrimary = true
		}

		interfaces = append(interfaces, ni)
	}

	// If no primary found, mark first with IP as primary
	hasPrimary := false
	for _, ni := range interfaces {
		if ni.IsPrimary {
			hasPrimary = true
			break
		}
	}

	if !hasPrimary {
		for i := range interfaces {
			if interfaces[i].IPAddress != "" {
				interfaces[i].IsPrimary = true
				break
			}
		}
	}

	return interfaces, nil
}

func isPrivateIP(ip string) bool {
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return false
	}

	privateBlocks := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
	}

	for _, block := range privateBlocks {
		_, cidr, _ := net.ParseCIDR(block)
		if cidr.Contains(parsedIP) {
			return true
		}
	}

	return false
}
