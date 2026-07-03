//go:build darwin

package collectors

import "log/slog"

// collectPlatformBattery reads current power state via `pmset -g batt`. A single
// short-lived spawn per heartbeat — the darwin collectors already shell out to
// system_profiler/scutil/etc., so this is comparable in cost.
func collectPlatformBattery() *BatteryInfo {
	out, err := runCollectorOutput(collectorShortCommandTimeout, "pmset", "-g", "batt")
	if err != nil {
		slog.Warn("pmset -g batt failed", "error", err.Error())
		return nil
	}
	return parsePmsetBatt(string(out))
}
