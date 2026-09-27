//go:build darwin

package main

import (
	"strings"
	"testing"
)

// TestMigrateLegacyInstallIfNeededCopiesAndSchedulesReloadFromLegacyPath
// mirrors internal/agentapp's identical test for the agent binary; see
// there for the full rationale.
func TestMigrateLegacyInstallIfNeededCopiesAndSchedulesReloadFromLegacyPath(t *testing.T) {
	var migratedFrom, migratedTo string
	var scheduledScript string
	deps := migrateDarwinDeps{
		geteuid:    func() int { return 0 },
		executable: func() (string, error) { return "/usr/local/bin/breeze-watchdog", nil },
		migrate: func(legacyPath, trustedDir string) (string, error) {
			migratedFrom, migratedTo = legacyPath, trustedDir
			return trustedDir + "/breeze-watchdog", nil
		},
		startDetached: func(script string) error {
			scheduledScript = script
			return nil
		},
	}

	migrateLegacyInstallIfNeeded(deps, "/Library/LaunchDaemons/com.breeze.watchdog.plist")

	if migratedFrom != "/usr/local/bin/breeze-watchdog" {
		t.Errorf("migrated from %q, want the legacy path", migratedFrom)
	}
	if migratedTo != "/Library/Breeze/bin" {
		t.Errorf("migrated to %q, want the trusted directory", migratedTo)
	}
	if !strings.Contains(scheduledScript, "/usr/local/bin/breeze-watchdog") ||
		!strings.Contains(scheduledScript, "/Library/Breeze/bin/breeze-watchdog") {
		t.Errorf("relocation script = %q, want it to reference both the old and new paths", scheduledScript)
	}
}

// TestMigrateLegacyInstallIfNeededSkipsWhenNotPrivileged mirrors
// internal/agentapp's identical test.
func TestMigrateLegacyInstallIfNeededSkipsWhenNotPrivileged(t *testing.T) {
	deps := migrateDarwinDeps{
		geteuid: func() int { return 501 },
		executable: func() (string, error) {
			t.Fatal("executable() must not be called when not privileged")
			return "", nil
		},
		migrate: func(string, string) (string, error) {
			t.Fatal("migrate() must not be called when not privileged")
			return "", nil
		},
		startDetached: func(string) error {
			t.Fatal("startDetached() must not be called when not privileged")
			return nil
		},
	}
	migrateLegacyInstallIfNeeded(deps, "/Library/LaunchDaemons/com.breeze.watchdog.plist")
}
