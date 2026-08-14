package collectors

import (
	"github.com/shirou/gopsutil/v3/net"
)

// netIOCounters is the gopsutil entry point used by safeNetIOCounters. It is a
// variable purely so tests can inject a panicking implementation — there is no
// other way to exercise the recovery path, since whether the real gopsutil
// panics depends on the host's `netstat` output.
var netIOCounters = net.IOCounters

// safeNetIOCounters wraps gopsutil's net.IOCounters, converting a panic into an
// error so the rest of the metrics sample (CPU, RAM, disk) still gets reported.
//
// Why this is needed: gopsutil's darwin implementation reads columns[0] and
// columns[2] of each `netstat -ibdnW` line with no length check
// (net/net_darwin.go parseNetstatLine), so a line with fewer fields than
// expected panics with "index out of range". On newer macOS that has taken down
// the metrics goroutine mid-heartbeat (issue #3459).
//
// Upgrading does NOT fix this: the same unguarded indexing is still present in
// gopsutil v4.26.7, whose first len(columns) check sits after both accesses, so
// there is no released version to move to. Guarding at our own call site is the
// fix until upstream adds the bounds check.
//
// Behaviour on panic matches gopsutil's own error path for a malformed line
// (parseNetstatOutput already fails the whole call on any unparsable line), so
// this loses no data that would otherwise have been collected — it only stops
// the crash from escaping. recoverAs reports the panic to Sentry and logs it,
// so recovery here is not a silent failure.
func safeNetIOCounters(pernic bool) (stats []net.IOCountersStat, err error) {
	defer recoverAs("net.IOCounters", &err)
	return netIOCounters(pernic)
}
