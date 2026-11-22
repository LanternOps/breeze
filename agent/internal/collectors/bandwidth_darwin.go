//go:build darwin

package collectors

import (
	"log/slog"
	"os"
	"regexp"
	"strings"
	"syscall"
)

var darwinInterfaceNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,32}$`)

// getLinkSpeed returns the link speed in bits/sec for the named interface on macOS.
// Uses networksetup to query the hardware port speed. Returns 0 if unavailable.
func getLinkSpeed(ifaceName string) uint64 {
	if !darwinInterfaceNamePattern.MatchString(ifaceName) {
		return 0
	}
	// Map interface name (e.g. en0) to hardware port via networksetup
	out, err := runCollectorOutput(collectorShortCommandTimeout, "networksetup", "-listallhardwareports")
	if err != nil {
		slog.Debug("failed to get link speed: networksetup command failed", "iface", ifaceName, "error", err.Error())
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
	out, err = runCollectorOutput(collectorShortCommandTimeout, "ifconfig", ifaceName)
	if err != nil {
		slog.Debug("failed to get link speed: ifconfig command failed", "iface", ifaceName, "error", err.Error())
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

// wifiSpeedSourceProbe caches which tool can read the Wi-Fi rate so hosts
// without a usable one stop spawning per tick (#10911).
var wifiSpeedSourceProbe = newCachedHostProbe(hostProbeAvailabilityTTL, detectWiFiSpeedSource)

func detectWiFiSpeedSource() wifiSpeedSource {
	version, _ := syscall.Sysctl("kern.osproductversion")
	src := selectWiFiSpeedSource(version, os.Geteuid() == 0, func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular()
	})
	slog.Debug("wifi speed source selected", "source", wifiSpeedSourceName(src), "macos", version)
	return src
}

func wifiSpeedSourceName(s wifiSpeedSource) string {
	switch s {
	case wifiSpeedAirport:
		return "airport"
	case wifiSpeedWdutil:
		return "wdutil"
	}
	return "none"
}

func getWiFiSpeed() uint64 {
	switch wifiSpeedSourceProbe.get() {
	case wifiSpeedAirport:
		out, err := runCollectorOutput(collectorShortCommandTimeout, airportPath, "-I")
		if err != nil {
			slog.Debug("failed to get wifi speed: airport command failed", "error", err.Error())
			return 0
		}
		return parseAirportTxRate(string(out))
	case wifiSpeedWdutil:
		out, err := runCollectorOutput(collectorShortCommandTimeout, wdutilPath, "info")
		if err != nil {
			slog.Debug("failed to get wifi speed: wdutil command failed", "error", err.Error())
			return 0
		}
		return parseWdutilTxRate(string(out))
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
