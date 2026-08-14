package collectors

import (
	"errors"
	"log/slog"
	"sync"

	"github.com/shirou/gopsutil/v3/net"
)

// netIOStackLogged ensures the (large) panic stack is logged once per process
// rather than on every collection cycle — on an affected host the panic recurs
// every heartbeat, and the stack is only diagnostic value the first time.
var netIOStackLogged sync.Once

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
// gopsutil v4.26.7, so there is no released version to move to. Guarding at our
// own call site is the fix until upstream adds the bounds check.
//
// Behaviour on panic matches gopsutil's own error path for a malformed line
// (parseNetstatOutput already fails the whole call on any unparsable line), so
// this loses no data that would otherwise have been collected — it only stops
// the crash from escaping.
func safeNetIOCounters(pernic bool) (stats []net.IOCountersStat, err error) {
	defer recoverAs("net.IOCounters", &err)
	return net.IOCounters(pernic)
}

// logNetIOPanic reports a recovered net.IOCounters panic. Ordinary
// (non-panic) IOCounters errors are left to the caller's existing handling.
func logNetIOPanic(pernic bool, err error) {
	var panicErr *PanicError
	if !errors.As(err, &panicErr) {
		return
	}
	slog.Warn("network IO counters panicked; skipping network metrics this cycle",
		"pernic", pernic, "error", panicErr.Error())
	netIOStackLogged.Do(func() {
		slog.Warn("network IO counters panic stack", "stack", panicErr.Stack)
	})
}
