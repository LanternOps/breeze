//go:build !windows

package etwlua

// NewETWSubscriber is a no-op stub on non-Windows platforms. ETW only
// exists on Windows, so this returns nil and a sentinel error; main.go
// (and any other caller) treats nil as "don't start the etwlua loop".
//
// The signature mirrors etwlua_windows.go so the caller can compile on
// every platform without build-tag noise at the call site.
func NewETWSubscriber() (Subscriber, error) {
	return nil, ErrNotSupported
}
