//go:build darwin

package collectors

import (
	"strings"
)

// Collect gathers reliability metrics from uptime + macOS crash/log telemetry.
func (c *ReliabilityCollector) Collect() (*ReliabilityMetrics, error) {
	metrics, err := c.collectBase()
	if err != nil {
		return nil, err
	}

	events, err := c.eventLogCol.Collect()
	if err != nil {
		return metrics, nil
	}

	for _, entry := range events {
		ts := normalizeEventTimestamp(entry.Timestamp)
		msg := strings.ToLower(entry.Message)
		src := strings.ToLower(entry.Source)
		level := strings.ToLower(entry.Level)

		switch {
		case strings.Contains(msg, "kernel panic"), strings.Contains(msg, "panic("):
			appendCrash(metrics, "kernel_panic", ts, map[string]any{
				"source":  entry.Source,
				"eventId": entry.EventID,
			})

		case strings.Contains(msg, "application crash"), strings.Contains(msg, "crashed"):
			appendCrash(metrics, "system_crash", ts, map[string]any{
				"source":  entry.Source,
				"eventId": entry.EventID,
			})

		case strings.Contains(msg, "hang"), strings.Contains(msg, "not responding"):
			appendHang(metrics, entry.Source, ts)

		case strings.Contains(src, "launchd") && (strings.Contains(msg, "exited") || strings.Contains(msg, "failed")):
			appendServiceFailure(metrics, entry.Source, ts, entry.EventID)
		}

		if entry.Category == "hardware" || strings.Contains(msg, "i/o error") || strings.Contains(msg, "memory") {
			appendHardwareError(metrics, entry, ts)
			continue
		}

		if level == "critical" && entry.Category == "system" && strings.Contains(msg, "shutdown") {
			appendCrash(metrics, "system_crash", ts, map[string]any{
				"source": entry.Source,
			})
		}
	}

	return metrics, nil
}
