package collectors

import (
	"math"
	"strconv"
	"strings"
)

const (
	airportPath = "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport"
	wdutilPath  = "/usr/bin/wdutil"
)

// wifiSpeedSource says which macOS tool can report the Wi-Fi link rate here.
type wifiSpeedSource int

const (
	wifiSpeedNone wifiSpeedSource = iota
	wifiSpeedAirport
	wifiSpeedWdutil
)

// macOSVersionAtLeast compares a "14.4.1" style version; known is false when it does not parse.
func macOSVersionAtLeast(version string, major, minor int) (atLeast, known bool) {
	parts := strings.Split(strings.TrimSpace(version), ".")
	maj, err := strconv.Atoi(parts[0])
	if err != nil {
		return false, false
	}
	minorPart := 0
	if len(parts) > 1 {
		if minorPart, err = strconv.Atoi(parts[1]); err != nil {
			return false, false
		}
	}
	return maj > major || (maj == major && minorPart >= minor), true
}

// selectWiFiSpeedSource keeps airport wherever it still works and uses wdutil
// only as root, because wdutil refuses to run otherwise.
func selectWiFiSpeedSource(version string, isRoot bool, exists func(path string) bool) wifiSpeedSource {
	modern, known := macOSVersionAtLeast(version, 14, 4)
	if (!known || !modern) && exists(airportPath) {
		return wifiSpeedAirport
	}
	if isRoot && exists(wdutilPath) {
		return wifiSpeedWdutil
	}
	return wifiSpeedNone
}

func parseAirportTxRate(out string) uint64 {
	for _, line := range strings.Split(out, "\n") {
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

// parseWdutilTxRate reads the "Tx Rate : 702.0 Mbps" line; a disconnected radio prints "None".
func parseWdutilTxRate(out string) uint64 {
	for _, line := range strings.Split(out, "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if !found || strings.TrimSpace(key) != "Tx Rate" {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) == 0 {
			return 0
		}
		mbps, err := strconv.ParseFloat(fields[0], 64)
		if err != nil || mbps <= 0 || math.IsInf(mbps, 0) || math.IsNaN(mbps) {
			return 0
		}
		return uint64(math.Floor(mbps * 1_000_000))
	}
	return 0
}
