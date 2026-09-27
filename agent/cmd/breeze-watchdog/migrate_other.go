//go:build !darwin

package main

// maybeMigrateLegacyInstall is a no-op on platforms other than macOS.
// See internal/agentapp's identical stub for the rationale.
func maybeMigrateLegacyInstall() {}
