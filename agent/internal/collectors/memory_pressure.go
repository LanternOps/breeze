package collectors

import (
	"fmt"
	"regexp"
	"strconv"
)

var (
	memoryPressureTotalRe = regexp.MustCompile(`(?m)^The system has\s+(\d+)\s+\(`)
	memoryPressureFreeRe  = regexp.MustCompile(`(?m)^System-wide memory free percentage:\s+([0-9]+(?:\.[0-9]+)?)%`)
)

func parseMemoryPressureOutput(output string) (totalBytes uint64, freePercent float64, err error) {
	totalMatch := memoryPressureTotalRe.FindStringSubmatch(output)
	if len(totalMatch) != 2 {
		return 0, 0, fmt.Errorf("missing total memory")
	}
	totalBytes, err = strconv.ParseUint(totalMatch[1], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("parse total memory: %w", err)
	}
	if totalBytes == 0 {
		return 0, 0, fmt.Errorf("total memory is zero")
	}

	freeMatch := memoryPressureFreeRe.FindStringSubmatch(output)
	if len(freeMatch) != 2 {
		return 0, 0, fmt.Errorf("missing free percentage")
	}
	freePercent, err = strconv.ParseFloat(freeMatch[1], 64)
	if err != nil {
		return 0, 0, fmt.Errorf("parse free percentage: %w", err)
	}
	if freePercent < 0 || freePercent > 100 {
		return 0, 0, fmt.Errorf("free percentage %.2f out of range", freePercent)
	}

	return totalBytes, freePercent, nil
}

func applyPressureAwareMemoryMetrics(metrics *SystemMetrics, totalBytes uint64, freePercent float64) {
	usedPercent := 100 - freePercent
	metrics.RAMPercent = usedPercent
	// RAMUsedMB is the pressure-used equivalent for consistency with RAMPercent,
	// not literal resident/allocated memory.
	metrics.RAMUsedMB = uint64((float64(totalBytes) * usedPercent / 100) / bytesPerMiB)
}
