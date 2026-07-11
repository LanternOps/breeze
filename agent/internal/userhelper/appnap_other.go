//go:build !darwin || !cgo

package userhelper

// guardAgainstAppNap is a no-op on non-macOS platforms or when CGO is disabled.
// App Nap is a macOS-only power-management behavior, so there is nothing to
// guard against elsewhere (issue #2273).
func guardAgainstAppNap() {}
