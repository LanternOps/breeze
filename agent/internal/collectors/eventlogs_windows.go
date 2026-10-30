//go:build windows

package collectors

import "time"

// Collect executes the Windows streams; all query and bookmark logic is shared
// with the platform-neutral tests.
func (c *EventLogCollector) Collect() ([]EventLogEntry, error) {
	return c.collectWindowsStreams(func(logName, xpath string) ([]winEvent, error) {
		cmd := buildWinEventCommand(logName, xpath)
		output, err := runCollectorOutput(collectorLongCommandTimeout, "powershell", "-NoProfile", "-NonInteractive", "-Command", utf8PowerShellCommand(cmd))
		return winEventQueryOutput(output, err)
	}, time.Now()), nil
}
