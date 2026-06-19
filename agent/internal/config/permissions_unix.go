//go:build !windows

package config

import "os"

// The Breeze Helper ("Breeze Assist") runs as the logged-in user, while the
// agent writes these files as root. The user is neither the owner (root) nor in
// the owning group (wheel), so the config dir must be traversable (0755) and
// agent.yaml world-readable (0644) for the Helper to read its server URL,
// agent ID, and helper-scoped token. The full agent/watchdog tokens and mTLS
// keys are NOT in agent.yaml — they live in secrets.yaml, which stays
// owner-only (0600).

func enforceConfigDirPermissions(path string) error {
	return os.Chmod(path, 0755)
}

func enforceConfigFilePermissions(path string) error {
	return os.Chmod(path, 0644)
}

func enforceSecretFilePermissionsImpl(path string) error {
	return os.Chmod(path, 0600)
}

// enforceSecretFilePermissions is a package-level var so tests can inject a
// failure to verify that SaveTo propagates it as a fatal error. Production
// code always routes through enforceSecretFilePermissionsImpl.
var enforceSecretFilePermissions = enforceSecretFilePermissionsImpl

// ProgramData ACL drift is a Windows-only concern (the MSI HardenProgramDataAcl
// DACL hardening has no Unix analog), so detection always reports "clean" and
// re-application is a no-op here. See permissions_drift.go.
func programDataDirACLDrifted(string) (bool, error) { return false, nil }

func enforceProgramDataDirPermissions(string) error { return nil }
