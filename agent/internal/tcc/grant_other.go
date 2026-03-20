//go:build !darwin

package tcc

// GrantResult holds the outcome of a TCC grant attempt for a single service.
type GrantResult struct {
	Service string
	Name    string
	Granted bool
	Already bool
	Err     error
}

// EnsurePermissions is a no-op on non-macOS platforms.
// TCC (Transparency, Consent, and Control) is a macOS-only subsystem.
func EnsurePermissions() ([]GrantResult, error) {
	return nil, nil
}
