package collectors

import (
	"fmt"
	"strings"
	"time"
)

// macOS unified-log (`log show`) predicate fragments per collector category.
// This file is platform-neutral (no build tag) so predicate construction,
// entry re-categorization, and window math are unit-testable on Linux CI;
// eventlogs_darwin.go is the only runtime caller.
const (
	// securityUnifiedLogPredicate matches auth failures and TCC changes.
	securityUnifiedLogPredicate = `subsystem == "com.apple.opendirectoryd" OR eventMessage CONTAINS[c] "authentication" OR subsystem == "com.apple.TCC"`
	// hardwareUnifiedLogPredicate matches disk, thermal, and kernel errors.
	hardwareUnifiedLogPredicate = `(subsystem CONTAINS "com.apple.iokit" AND messageType >= error) OR eventMessage CONTAINS[c] "thermal" OR eventMessage CONTAINS[c] "kernel panic"`
)

// unifiedLogMaxLookback bounds the `log show --start` window. Querying the
// unified log is expensive regardless of how little it returns (issue #2390),
// and the cost grows with the window, so a collector that was asleep/offline
// for a long time must not trigger an unbounded scan. This also intentionally
// caps the ReliabilityCollector's 24h first-run lookback for the unified log:
// its authoritative long-window crash signal comes from DiagnosticReports
// (crash files), which honor the full lookback cheaply.
const unifiedLogMaxLookback = 60 * time.Minute

// buildUnifiedLogPredicate returns the single merged `log show` predicate for
// the enabled unified-log categories, or "" when neither is enabled. The
// security and hardware categories share ONE `log show` invocation — each
// invocation burns seconds of CPU even when it returns nothing (issue #2390)
// — and entries are re-categorized in Go via classifyUnifiedLogCategory.
func buildUnifiedLogPredicate(securityEnabled, hardwareEnabled bool) string {
	var base string
	switch {
	case securityEnabled && hardwareEnabled:
		base = fmt.Sprintf("(%s) OR (%s)", securityUnifiedLogPredicate, hardwareUnifiedLogPredicate)
	case securityEnabled:
		base = securityUnifiedLogPredicate
	case hardwareEnabled:
		base = hardwareUnifiedLogPredicate
	default:
		return ""
	}
	// Wrap with a messageType filter so macOS filters at the source. The Go
	// code only keeps error/fault entries anyway, so this avoids downloading
	// megabytes of info/debug JSON that would be discarded.
	return fmt.Sprintf("(%s) AND (messageType >= error)", base)
}

// classifyUnifiedLogCategory stamps the collector category for a unified-log
// entry returned by the merged query. It mirrors securityUnifiedLogPredicate:
// entries matched by the security clauses are "security"; everything else was
// matched by the hardware clauses. When only one category is enabled, the
// merged predicate contained only that category's clauses, so every returned
// entry belongs to it.
func classifyUnifiedLogCategory(subsystem, message string, securityEnabled, hardwareEnabled bool) string {
	switch {
	case securityEnabled && !hardwareEnabled:
		return "security"
	case hardwareEnabled && !securityEnabled:
		return "hardware"
	}
	if subsystem == "com.apple.opendirectoryd" || subsystem == "com.apple.TCC" ||
		strings.Contains(strings.ToLower(message), "authentication") {
		return "security"
	}
	return "hardware"
}

// unifiedLogQueryStart clamps the `--start` timestamp for a unified-log
// query: never in the future (clock steps) and never more than
// unifiedLogMaxLookback ago. Using an explicit --start instead of the old
// floor-truncated `--last Nm` closes the window gap between passes (a floored
// window began AFTER the previous pass's end, silently dropping events).
func unifiedLogQueryStart(since, now time.Time) time.Time {
	if since.After(now) {
		return now
	}
	if oldest := now.Add(-unifiedLogMaxLookback); since.Before(oldest) {
		return oldest
	}
	return since
}
