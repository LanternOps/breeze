//go:build linux

package collectors

// Collect is a stub on Linux — future: implement via journalctl
func (c *EventLogCollector) Collect() ([]EventLogEntry, error) {
	return nil, nil
}
