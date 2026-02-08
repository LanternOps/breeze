//go:build linux

package collectors

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// getLinkSpeed returns the link speed in bits/sec for the named interface on Linux.
// Reads from /sys/class/net/<iface>/speed which reports Mbps. Returns 0 if unavailable.
func getLinkSpeed(ifaceName string) uint64 {
	speedPath := filepath.Join("/sys/class/net", ifaceName, "speed")
	data, err := os.ReadFile(speedPath)
	if err != nil {
		return 0
	}

	mbps, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || mbps <= 0 {
		// -1 means speed is unknown (e.g., wireless with no link)
		return 0
	}

	return uint64(mbps) * 1_000_000 // Mbps → bps
}
