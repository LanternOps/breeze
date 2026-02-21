//go:build windows

package collectors

import (
	"strings"
)

// Collect gathers reliability metrics from uptime + Windows event signals.
func (c *ReliabilityCollector) Collect() (*ReliabilityMetrics, error) {
	metrics, err := c.collectBase()
	if err != nil {
		return nil, err
	}

	events, err := c.eventLogCol.Collect()
	if err != nil {
		// Return base metrics even if event parsing fails.
		return metrics, nil
	}

	for _, entry := range events {
		ts := normalizeEventTimestamp(entry.Timestamp)
		msg := strings.ToLower(entry.Message)
		src := strings.ToLower(entry.Source)
		eid := strings.ToLower(entry.EventID)
		level := strings.ToLower(entry.Level)

		switch {
		case strings.Contains(msg, "bugcheck"), strings.Contains(msg, "blue screen"),
			strings.Contains(msg, "unexpected shutdown"), strings.Contains(eid, "1001"), strings.Contains(eid, "6008"):
			appendCrash(metrics, "bsod", ts, map[string]any{
				"source":  entry.Source,
				"eventId": entry.EventID,
				"level":   entry.Level,
			})

		case strings.Contains(msg, "kernel panic"):
			appendCrash(metrics, "kernel_panic", ts, map[string]any{
				"source":  entry.Source,
				"eventId": entry.EventID,
			})

		case strings.Contains(msg, "service") && (strings.Contains(msg, "terminated") || strings.Contains(msg, "failed") || strings.Contains(eid, "7034")):
			appendServiceFailure(metrics, entry.Source, ts, entry.EventID)

		case strings.Contains(msg, "hang"), strings.Contains(msg, "not responding"):
			appendHang(metrics, entry.Source, ts)
		}

		if entry.Category == "hardware" || strings.Contains(src, "whea") || strings.Contains(msg, "disk") || strings.Contains(msg, "memory") {
			appendHardwareError(metrics, entry, ts)
			continue
		}

		if level == "critical" && entry.Category == "system" && strings.Contains(msg, "crash") {
			appendCrash(metrics, "system_crash", ts, map[string]any{
				"source":  entry.Source,
				"eventId": entry.EventID,
			})
		}
	}

	return metrics, nil
}
