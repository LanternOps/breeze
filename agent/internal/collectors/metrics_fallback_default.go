//go:build !darwin || cgo

package collectors

import (
	"fmt"

	"github.com/shirou/gopsutil/v3/disk"
)

// cpuPercentFallback is a no-op on platforms where gopsutil works with CGO.
func cpuPercentFallback() (float64, error) {
	return 0, fmt.Errorf("no fallback available")
}

// diskIOCountersFallback is a no-op on platforms where gopsutil works with CGO.
func diskIOCountersFallback() (map[string]disk.IOCountersStat, error) {
	return nil, fmt.Errorf("no fallback available")
}
