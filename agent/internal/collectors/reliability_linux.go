//go:build linux

package collectors

// Collect gathers reliability metrics from uptime + Linux journal/syslog signals.
// Classification lives in classifyLinuxEventLogEntry (reliability_unix.go) so it
// is unit-testable on CI.
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
		classifyLinuxEventLogEntry(metrics, entry)
	}

	return metrics, nil
}
