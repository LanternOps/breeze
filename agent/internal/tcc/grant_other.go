//go:build !darwin

// Package tcc provides read-only probes of macOS TCC permission state.
// TCC (Transparency, Consent, and Control) is a macOS-only subsystem, so
// the probes are no-ops on other platforms.
package tcc

// CheckFDA is a no-op on non-macOS platforms. Always returns false.
func CheckFDA() bool {
	return false
}
