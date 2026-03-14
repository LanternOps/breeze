//go:build darwin && !cgo

package collectors

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"time"

	"github.com/shirou/gopsutil/v3/disk"
)

// cpuPercentFallback returns CPU usage by parsing macOS `top` output.
// Used when gopsutil fails (CGO_ENABLED=0 builds).
func cpuPercentFallback() (float64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "top", "-l", "1", "-n", "0", "-s", "0").Output()
	if err != nil {
		return 0, fmt.Errorf("top failed: %w", err)
	}

	// Parse "CPU usage: X% user, Y% sys, Z% idle"
	re := regexp.MustCompile(`CPU usage:\s+([\d.]+)%\s+user,\s+([\d.]+)%\s+sys`)
	m := re.FindStringSubmatch(string(out))
	if len(m) < 3 {
		return 0, fmt.Errorf("failed to parse CPU usage from top output")
	}

	user, _ := strconv.ParseFloat(m[1], 64)
	sys, _ := strconv.ParseFloat(m[2], 64)

	return user + sys, nil
}

// diskIOCountersFallback returns disk IO statistics by parsing macOS `ioreg` output.
// Parses all IOBlockStorageDriver Statistics blocks and returns the one with the
// highest total IO (the physical disk), avoiding double-counting from sub-components.
func diskIOCountersFallback() (map[string]disk.IOCountersStat, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "ioreg", "-c", "IOBlockStorageDriver", "-r", "-w", "0").Output()
	if err != nil {
		return nil, fmt.Errorf("ioreg failed: %w", err)
	}

	statsRe := regexp.MustCompile(`"Statistics"\s*=\s*\{([^}]+)\}`)
	bytesReadRe := regexp.MustCompile(`"Bytes \(Read\)"\s*=\s*(\d+)`)
	bytesWriteRe := regexp.MustCompile(`"Bytes \(Write\)"\s*=\s*(\d+)`)
	opsReadRe := regexp.MustCompile(`"Operations \(Read\)"\s*=\s*(\d+)`)
	opsWriteRe := regexp.MustCompile(`"Operations \(Write\)"\s*=\s*(\d+)`)

	matches := statsRe.FindAllStringSubmatch(string(out), -1)

	// Find the entry with the highest total IO — this is the physical disk.
	// Sub-component entries (APFS partitions, recovery volumes) have smaller
	// counters that are already included in the physical disk's totals.
	var best disk.IOCountersStat
	var bestTotal uint64

	for _, m := range matches {
		s := m[1]

		// Only process IOBlockStorageDriver-style stats (have "Retries" key)
		if !bytesReadRe.MatchString(s) {
			continue
		}

		var stats disk.IOCountersStat
		if bm := bytesReadRe.FindStringSubmatch(s); len(bm) > 1 {
			stats.ReadBytes, _ = strconv.ParseUint(bm[1], 10, 64)
		}
		if bm := bytesWriteRe.FindStringSubmatch(s); len(bm) > 1 {
			stats.WriteBytes, _ = strconv.ParseUint(bm[1], 10, 64)
		}
		if bm := opsReadRe.FindStringSubmatch(s); len(bm) > 1 {
			stats.ReadCount, _ = strconv.ParseUint(bm[1], 10, 64)
		}
		if bm := opsWriteRe.FindStringSubmatch(s); len(bm) > 1 {
			stats.WriteCount, _ = strconv.ParseUint(bm[1], 10, 64)
		}

		total := stats.ReadBytes + stats.WriteBytes
		if total > bestTotal {
			best = stats
			bestTotal = total
		}
	}

	if bestTotal == 0 {
		return nil, fmt.Errorf("no disk IO statistics found")
	}

	best.Name = "disk0"
	return map[string]disk.IOCountersStat{"disk0": best}, nil
}
