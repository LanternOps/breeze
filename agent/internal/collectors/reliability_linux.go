//go:build linux

package collectors

import (
	"strings"
)

// Collect gathers reliability metrics from uptime + Linux journal/syslog signals.
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

		classified := true
		switch {
		case strings.Contains(msg, "kernel panic"), strings.Contains(msg, "oops"), strings.Contains(msg, "segfault"):
			appendCrash(metrics, "kernel_panic", ts, map[string]any{
				"source":  entry.Source,
				"eventId": entry.EventID,
			})

		case strings.Contains(msg, "oom"), strings.Contains(msg, "out of memory"):
			appendCrash(metrics, "oom_kill", ts, map[string]any{
				"source":  entry.Source,
				"eventId": entry.EventID,
			})

		case strings.Contains(msg, "service") && (strings.Contains(msg, "failed") || strings.Contains(msg, "failure")),
			strings.Contains(src, "systemd") && strings.Contains(msg, "failed"):
			appendServiceFailure(metrics, entry.Source, ts, entry.EventID)

		case strings.Contains(msg, "hang"), strings.Contains(msg, "not responding"), strings.Contains(msg, "blocked for more than"):
			appendHang(metrics, entry.Source, ts)

		default:
			classified = false
		}

		if !classified && (entry.Category == "hardware" || strings.Contains(msg, "i/o error") || strings.Contains(msg, "edac") || strings.Contains(msg, "mce")) {
			appendHardwareError(metrics, entry, ts)
		}
	}

	return metrics, nil
}
