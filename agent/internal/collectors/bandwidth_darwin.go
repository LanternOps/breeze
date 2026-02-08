//go:build darwin

package collectors

import (
	"os/exec"
	"strconv"
	"strings"
)

// getLinkSpeed returns the link speed in bits/sec for the named interface on macOS.
// Uses networksetup to query the hardware port speed. Returns 0 if unavailable.
func getLinkSpeed(ifaceName string) uint64 {
	// Map interface name (e.g. en0) to hardware port via networksetup
	out, err := exec.Command("networksetup", "-listallhardwareports").Output()
	if err != nil {
		return 0
	}

	// Parse output to find the hardware port matching our interface
	lines := strings.Split(string(out), "\n")
	var portName string
	for i, line := range lines {
		if strings.Contains(line, "Device: "+ifaceName) && i > 0 {
			prev := lines[i-1]
			if strings.HasPrefix(prev, "Hardware Port: ") {
				portName = strings.TrimPrefix(prev, "Hardware Port: ")
			}
			break
		}
	}

	if portName == "" {
		return 0
	}

	// For Wi-Fi, use airport to get link speed
	if strings.Contains(strings.ToLower(portName), "wi-fi") || strings.Contains(strings.ToLower(portName), "airport") {
		return getWiFiSpeed()
	}

	// For Ethernet, query media speed
	out, err = exec.Command("ifconfig", ifaceName).Output()
	if err != nil {
		return 0
	}

	// Look for "media: autoselect (1000baseT ...)" pattern
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "media:") {
			return parseMediaSpeed(line)
		}
	}

	return 0
}

func getWiFiSpeed() uint64 {
	// Try the system_profiler approach
	out, err := exec.Command("/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport", "-I").Output()
	if err != nil {
		return 0
	}

	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "lastTxRate:") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				mbps, err := strconv.ParseUint(parts[1], 10, 64)
				if err == nil {
					return mbps * 1_000_000 // Mbps → bps
				}
			}
		}
	}
	return 0
}

func parseMediaSpeed(mediaLine string) uint64 {
	lower := strings.ToLower(mediaLine)
	switch {
	case strings.Contains(lower, "100gbase"):
		return 100_000_000_000
	case strings.Contains(lower, "40gbase"):
		return 40_000_000_000
	case strings.Contains(lower, "25gbase"):
		return 25_000_000_000
	case strings.Contains(lower, "10gbase"):
		return 10_000_000_000
	case strings.Contains(lower, "5gbase"):
		return 5_000_000_000
	case strings.Contains(lower, "2500base"):
		return 2_500_000_000
	case strings.Contains(lower, "1000base"):
		return 1_000_000_000
	case strings.Contains(lower, "100base"):
		return 100_000_000
	case strings.Contains(lower, "10base"):
		return 10_000_000
	}
	return 0
}
