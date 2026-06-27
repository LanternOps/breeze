package collectors

import "strings"

// classifyDarwinEventLogEntry routes a single macOS event-log entry into exactly
// one reliability factor (crash / hang / service-failure / hardware-error) or
// none. It is platform-neutral (no build tag) so it can be unit-tested on Linux
// CI; reliability_darwin.go calls it from the darwin-only Collect loop.
//
// Junk that previously drowned macOS scores is handled here:
//   - JetsamEvent (memory-pressure) reports are not crashes by any measure and
//     are dropped entirely.
//   - Per-app crash reports count, but as a weak "app_crash" type — the API
//     downweights them relative to a kernel panic / BSOD, since an app crashing
//     is app instability, not whole-device failure.
//   - Generic com.apple.iokit.* error/fault chatter (cfplugin, appstore, …) is
//     hard-tagged Category="hardware" by collectHardwareErrors; counting it
//     drowned scores in benign noise. Hardware now gates on a genuine fault
//     signal (thermal / disk-I/O / memory / MCE), never on entry.Category.
func classifyDarwinEventLogEntry(metrics *ReliabilityMetrics, entry EventLogEntry) {
	ts := normalizeEventTimestamp(entry.Timestamp)
	msg := strings.ToLower(entry.Message)
	src := strings.ToLower(entry.Source)
	level := strings.ToLower(entry.Level)
	nid := numericEventID(entry)

	// JetsamEvent reports are memory-pressure notices, not crashes — never count.
	if strings.Contains(strings.ToLower(entry.EventID), "jetsam") || strings.Contains(src, "jetsam") {
		return
	}

	switch {
	case strings.Contains(msg, "kernel panic"), strings.Contains(msg, "panic("):
		appendCrash(metrics, "kernel_panic", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
		})
		return

	case strings.Contains(msg, "application crash"), strings.Contains(msg, "crashed"):
		appendCrash(metrics, "app_crash", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
		})
		return

	case strings.Contains(msg, "hang"), strings.Contains(msg, "not responding"):
		appendHang(metrics, entry.Source, ts)
		return

	case strings.Contains(src, "launchd") && (strings.Contains(msg, "exited") || strings.Contains(msg, "failed")):
		appendServiceFailure(metrics, entry.Source, ts, entry.EventID)
		return

	case level == "critical" && entry.Category == "system" && strings.Contains(msg, "shutdown"):
		appendCrash(metrics, "system_crash", ts, map[string]any{
			"source": entry.Source,
		})
		return
	}

	// Hardware: genuine hardware faults only. classifyHardwareType matches
	// MCE / memory / disk-I/O signals; thermal is macOS-specific. Benign IOKit
	// plugin/appstore errors return "unknown" and are dropped.
	if classifyHardwareType(entry.Message, entry.Source, nid) != "unknown" || strings.Contains(msg, "thermal") {
		appendHardwareError(metrics, entry, ts)
	}
}

// classifyLinuxEventLogEntry routes a single Linux journal entry into exactly one
// reliability factor or none. Platform-neutral for CI testing; reliability_linux.go
// calls it from the linux-only Collect loop.
//
// collectKernelErrors hard-tags EVERY kernel-priority message Category="hardware",
// so the prior catch-all counted routine kernel chatter (USB resets, ACPI notices,
// rate-limit warnings) as hardware errors. Hardware now gates on a genuine fault
// signal (I/O error / MCE / EDAC-memory) via classifyHardwareType.
func classifyLinuxEventLogEntry(metrics *ReliabilityMetrics, entry EventLogEntry) {
	ts := normalizeEventTimestamp(entry.Timestamp)
	msg := strings.ToLower(entry.Message)
	src := strings.ToLower(entry.Source)
	nid := numericEventID(entry)

	switch {
	case strings.Contains(msg, "kernel panic"), strings.Contains(msg, "oops"), strings.Contains(msg, "segfault"):
		appendCrash(metrics, "kernel_panic", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
		})
		return

	case strings.Contains(msg, "oom"), strings.Contains(msg, "out of memory"):
		appendCrash(metrics, "oom_kill", ts, map[string]any{
			"source":  entry.Source,
			"eventId": entry.EventID,
		})
		return

	case strings.Contains(msg, "service") && (strings.Contains(msg, "failed") || strings.Contains(msg, "failure")),
		strings.Contains(src, "systemd") && strings.Contains(msg, "failed"):
		appendServiceFailure(metrics, entry.Source, ts, entry.EventID)
		return

	case strings.Contains(msg, "hang"), strings.Contains(msg, "not responding"), strings.Contains(msg, "blocked for more than"):
		appendHang(metrics, entry.Source, ts)
		return
	}

	// Hardware: genuine faults only (I/O / MCE / EDAC-memory), never entry.Category.
	if classifyHardwareType(entry.Message, entry.Source, nid) != "unknown" {
		appendHardwareError(metrics, entry, ts)
	}
}
