//go:build linux

package collectors

import (
	"fmt"
	"log/slog"
	"os/exec"
	"sync"
	"time"
)

// Collect gathers event logs from Linux sources (journalctl) in parallel
func (c *EventLogCollector) Collect() ([]EventLogEntry, error) {
	c.mu.Lock()
	lastCollect := c.lastCollectTime
	c.mu.Unlock()

	categories, minLevel, maxEvents := c.readConfig()

	type catCollector struct {
		category string
		fn       func(since time.Time) ([]EventLogEntry, error)
	}

	all := []catCollector{
		{"security", c.collectSecurityEvents},
		{"hardware", c.collectKernelErrors},
		{"application", c.collectServiceFailures},
		{"system", c.collectSystemEvents},
	}

	// Filter to only enabled categories
	var active []catCollector
	for _, cc := range all {
		if categoryEnabled(categories, cc.category) {
			active = append(active, cc)
		}
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	var allEvents []EventLogEntry

	wg.Add(len(active))
	for _, cc := range active {
		go func(f func(since time.Time) ([]EventLogEntry, error)) {
			defer wg.Done()
			events, err := f(lastCollect)
			if err != nil {
				slog.Warn("event log sub-collector error", "collector", c.name, "error", err.Error())
				return
			}
			mu.Lock()
			allEvents = append(allEvents, events...)
			mu.Unlock()
		}(cc.fn)
	}
	wg.Wait()

	c.mu.Lock()
	c.lastCollectTime = time.Now()
	c.mu.Unlock()

	// Filter by minimum level
	allEvents = filterByLevel(allEvents, minLevel)

	// Cap to maxEvents
	if len(allEvents) > maxEvents {
		allEvents = allEvents[:maxEvents]
	}

	return allEvents, nil
}

// collectSecurityEvents gathers auth failures, sudo events, sshd events
func (c *EventLogCollector) collectSecurityEvents(since time.Time) ([]EventLogEntry, error) {
	entries, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=sshd",
		"+", // OR
		"SYSLOG_IDENTIFIER=sudo",
		"+",
		"SYSLOG_IDENTIFIER=su",
		"+",
		"_COMM=pam",
	)
	if err != nil {
		return nil, err
	}
	return journalSecurityEvents(entries), nil
}

// collectKernelErrors gathers disk I/O errors, OOM kills, hardware errors from kernel
func (c *EventLogCollector) collectKernelErrors(since time.Time) ([]EventLogEntry, error) {
	entries, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=kernel",
		"PRIORITY=0..4", // emerg through warning
	)
	if err != nil {
		return nil, err
	}
	return journalKernelEvents(entries), nil
}

// collectServiceFailures gathers systemd unit failures and coredumps
func (c *EventLogCollector) collectServiceFailures(since time.Time) ([]EventLogEntry, error) {
	entries, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=systemd",
		"PRIORITY=0..3", // emerg through error
	)
	if err != nil {
		return nil, err
	}

	// Also check for coredumps
	coredumps, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=systemd-coredump",
	)
	if err == nil {
		entries = append(entries, coredumps...)
	}

	return journalServiceFailureEvents(entries), nil
}

// collectSystemEvents gathers boot, shutdown, and systemd lifecycle events
func (c *EventLogCollector) collectSystemEvents(since time.Time) ([]EventLogEntry, error) {
	entries, err := c.queryJournal(since,
		"SYSLOG_IDENTIFIER=systemd",
		"PRIORITY=4..6", // warning through info
	)
	if err != nil {
		return nil, err
	}
	return journalSystemEvents(entries), nil
}

// queryJournal runs journalctl with JSON output and returns parsed entries
func (c *EventLogCollector) queryJournal(since time.Time, matches ...string) ([]journalEntry, error) {
	sinceStr := since.UTC().Format("2006-01-02 15:04:05")

	args := []string{
		"--output=json",
		"--no-pager",
		"--since", sinceStr,
		"-n", "50",
	}
	args = append(args, matches...)

	output, err := runCollectorOutput(collectorLongCommandTimeout, "journalctl", args...)
	if err != nil {
		// journalctl returns exit code 1 when no entries match
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, fmt.Errorf("journalctl failed: %w", err)
	}

	if len(output) == 0 {
		return nil, nil
	}

	return parseJournalJSONLines(output), nil
}
