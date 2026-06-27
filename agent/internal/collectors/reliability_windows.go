//go:build windows

package collectors

import (
	"log/slog"
)

// Collect gathers reliability metrics from uptime + Windows event signals.
func (c *ReliabilityCollector) Collect() (*ReliabilityMetrics, error) {
	metrics, err := c.collectBase()
	if err != nil {
		return nil, err
	}

	events, err := c.eventLogCol.Collect()
	if err != nil {
		slog.Warn("reliability event log collection failed, returning base metrics only", "error", err.Error())
		return metrics, nil
	}

	for _, entry := range events {
		classifyEventLogEntry(metrics, entry)
	}

	return metrics, nil
}
