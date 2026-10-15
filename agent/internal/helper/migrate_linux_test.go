//go:build linux

package helper

import "testing"

// #8541: on Linux the legacy and current helper names are the same file. Pin
// that contract so the guard in migrateFromLegacyName stays meaningful if
// either path ever changes.
func TestLinuxLegacyAndCurrentHelperPathsMatch(t *testing.T) {
	if legacyBinaryPath() != defaultBinaryPath() {
		t.Fatalf("legacyBinaryPath() = %q, defaultBinaryPath() = %q; revisit migrateFromLegacyName before changing either",
			legacyBinaryPath(), defaultBinaryPath())
	}
	if !samePath(legacyBinaryPath(), defaultBinaryPath()) {
		t.Fatal("samePath must treat the Linux legacy and current paths as the same file")
	}
}
