package collectors

import (
	"fmt"
	"runtime/debug"
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

// recoverAs is a deferred helper that converts a panic into a *PanicError stored
// in *err. It must be called via defer:
//
//	func doThing() (err error) {
//	    defer recoverAs("thing", &err)
//	    ...
//	}
//
// A panic leaves the function's other (named or unnamed) results at their zero
// values, so callers must treat a non-nil error as "no usable result".
func recoverAs(op string, err *error) {
	if r := recover(); r != nil {
		*err = &PanicError{Op: op, Value: r, Stack: string(debug.Stack())}
	}
}

// Guard runs fn and converts any panic it raises into a *PanicError, so that a
// crash inside one collector degrades that collector instead of killing the
// goroutine driving the whole collection loop.
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
