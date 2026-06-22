//go:build darwin

package collectors

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

const memoryPressureCommandTimeout = 2 * time.Second
const memoryPressureCommandPath = "/usr/bin/memory_pressure"

var darwinMemoryPressureFallbackOnce sync.Once

func collectMemoryMetrics(metrics *SystemMetrics) {
	if err := collectDarwinPressureAwareMemoryMetrics(metrics); err == nil {
		return
	} else {
		darwinMemoryPressureFallbackOnce.Do(func() {
			slog.Warn("macOS pressure-aware memory collection failed, falling back to gopsutil", "error", err.Error())
		})
	}
	_ = collectGopsutilMemoryMetrics(metrics)
}

func collectDarwinPressureAwareMemoryMetrics(metrics *SystemMetrics) error {
	out, err := runCollectorOutput(memoryPressureCommandTimeout, memoryPressureCommandPath, "-Q")
	if err != nil {
		return fmt.Errorf("memory_pressure failed: %w", err)
	}
	totalBytes, freePercent, err := parseMemoryPressureOutput(string(out))
	if err != nil {
		return err
	}
	applyPressureAwareMemoryMetrics(metrics, totalBytes, freePercent)
	return nil
}
