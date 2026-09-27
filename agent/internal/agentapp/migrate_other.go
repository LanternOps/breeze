//go:build !darwin

package agentapp

// maybeMigrateLegacyInstall is a no-op on platforms other than macOS. Linux
// installs are not being relocated in this release (see
// internal/securefs/execowner_unix.go); Windows binary trust is tracked
// separately.
func maybeMigrateLegacyInstall() {}
