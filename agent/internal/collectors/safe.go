package collectors

import (
	"fmt"
	"regexp"
	"runtime/debug"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/observability"
)

// PanicError reports a panic that was recovered while running a collector (or a
// third-party library called by one). It is returned in place of the collector's
// normal error so callers can degrade the affected metric instead of losing the
// goroutine, while still being able to tell a crash apart from an ordinary
// collection failure via errors.As.
type PanicError struct {
	// Op names the operation that panicked, e.g. "metrics" or "net.IOCounters".
	Op string
	// Value is whatever was passed to panic().
	Value any
	// Stack is the goroutine stack captured at recover time.
	Stack string
}

func (e *PanicError) Error() string {
	return fmt.Sprintf("panic in %s: %v", e.Op, e.Value)
}

// panicReportInterval throttles Sentry reporting per (op, panic value). A
// collector panic caused by a bad host condition recurs on every collection
// cycle — every ~60s for metrics — so reporting unconditionally would flood
// Sentry from a single device. One event per key per interval keeps the signal
// (including the fact that it is still happening) without the flood.
const (
	panicReportInterval = time.Hour
	// panicReportKeyMax caps the key length so a panic value carrying command
	// output or a long path can't retain an oversized string.
	panicReportKeyMax = 160
	// panicReportMaxKeys bounds the throttle map. The agent runs for months, so
	// an unbounded map is a slow leak; on overflow we drop the whole table,
	// which at worst re-reports each live panic once.
	panicReportMaxKeys = 256
)

var (
	panicReportMu   sync.Mutex
	panicReportSeen = map[string]time.Time{}
	// panicReportDigits collapses the varying operands that Go runtime panics
	// embed ("index out of range [17] with length 12") so repeats of the SAME
	// bug share one key. Without this the key differs on nearly every
	// occurrence, which both grows the map without bound and defeats the
	// throttle entirely — the flood it exists to prevent.
	panicReportDigits = regexp.MustCompile(`\d+`)
)

// panicReportKey builds a throttle key that identifies the panic SITE and shape
// rather than its exact text.
func panicReportKey(op string, value any) string {
	key := op + "|" + panicReportDigits.ReplaceAllString(fmt.Sprintf("%v", value), "#")
	if len(key) > panicReportKeyMax {
		key = key[:panicReportKeyMax]
	}
	return key
}

// shouldReportPanic reports whether this (op, value) pair is due for a Sentry
// event, and records the decision. Split out so tests can exercise the
// throttle without touching Sentry.
func shouldReportPanic(op string, value any, now time.Time) bool {
	key := panicReportKey(op, value)

	panicReportMu.Lock()
	defer panicReportMu.Unlock()

	if last, ok := panicReportSeen[key]; ok && now.Sub(last) < panicReportInterval {
		return false
	}
	if len(panicReportSeen) >= panicReportMaxKeys {
		panicReportSeen = make(map[string]time.Time, panicReportMaxKeys)
	}
	panicReportSeen[key] = now
	return true
}

// recoverAs is a deferred helper that converts a panic into a *PanicError stored
// in *err, and reports it to Sentry. It must be called via defer:
//
//	func doThing() (err error) {
//	    defer recoverAs("thing", &err)
//	    ...
//	}
//
// A panic leaves the function's other (named or unnamed) results at their zero
// values, so callers must treat a non-nil error as "no usable result".
//
// Reporting happens here rather than at the call sites because converting a
// panic into an error stops it reaching any enclosing observability.Recoverer.
// Without this the crash would be invisible to fleet telemetry — which is how
// issue #3459 was noticed in the first place — and the stack would be dropped.
func recoverAs(op string, err *error) {
	if r := recover(); r != nil {
		stack := string(debug.Stack())
		*err = &PanicError{Op: op, Value: r, Stack: stack}
		if shouldReportPanic(op, r, time.Now()) {
			observability.ReportPanic("collectors."+op, r, stack)
		}
	}
}

// Guard runs fn and converts any panic it raises into a *PanicError, so that a
// crash inside one collector degrades that collector instead of killing the
// goroutine driving the whole collection loop. The panic is still reported to
// Sentry (throttled per op + panic value), so recovering does not hide it.
//
// On panic the returned result is the zero value for T (nil for the pointer and
// slice types the collectors return), so callers must check err before using it
// — the same contract they already have for ordinary collection errors.
//
// Motivating case: gopsutil's darwin netstat parser panics on unexpected
// `netstat -ibdnW` output and took down the metrics/heartbeat goroutine
// (issue #3459). A third-party parsing bug should never be fatal to collection.
func Guard[T any](op string, fn func() (T, error)) (result T, err error) {
	defer recoverAs(op, &err)
	return fn()
}
