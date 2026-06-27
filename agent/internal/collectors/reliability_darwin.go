//go:build darwin

package collectors

// Collect gathers reliability metrics from uptime + macOS crash/log telemetry.
// Classification lives in classifyDarwinEventLogEntry (reliability_unix.go) so it
// is unit-testable on Linux CI.
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
		classifyDarwinEventLogEntry(metrics, entry)
	}

	return metrics, nil
}
