//go:build darwin

package agentapp

import (
	"errors"
	"strings"
	"testing"
)

// TestMigrateLegacyInstallIfNeededSkipsWhenNotPrivileged proves the
// migration never touches the filesystem for an unprivileged caller (a
// developer running `breeze-agent run` by hand, or a test binary).
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
	migrateLegacyInstallIfNeeded(deps, "/Library/LaunchDaemons/com.breeze.agent.plist")
}

// TestMigrateLegacyInstallIfNeededSkipsWhenAlreadyTrusted proves an install
// already running from the trusted directory is left alone — no copy, no
// service reload.
func TestMigrateLegacyInstallIfNeededSkipsWhenAlreadyTrusted(t *testing.T) {
	deps := migrateDarwinDeps{
		geteuid:    func() int { return 0 },
		executable: func() (string, error) { return "/Library/Breeze/bin/breeze-agent", nil },
		migrate: func(string, string) (string, error) {
			t.Fatal("migrate() must not be called when already on the trusted path")
			return "", nil
		},
		startDetached: func(string) error {
			t.Fatal("startDetached() must not be called when already on the trusted path")
			return nil
		},
	}
	migrateLegacyInstallIfNeeded(deps, "/Library/LaunchDaemons/com.breeze.agent.plist")
}

// TestMigrateLegacyInstallIfNeededCopiesAndSchedulesReloadFromLegacyPath
// proves the happy path: a privileged process running from the legacy
// /usr/local/bin location gets copied to the trusted directory and the
// detached relocation script is scheduled with both paths.
func TestMigrateLegacyInstallIfNeededCopiesAndSchedulesReloadFromLegacyPath(t *testing.T) {
	var migratedFrom, migratedTo string
	var scheduledScript string
	deps := migrateDarwinDeps{
		geteuid:    func() int { return 0 },
		executable: func() (string, error) { return "/usr/local/bin/breeze-agent", nil },
		migrate: func(legacyPath, trustedDir string) (string, error) {
			migratedFrom, migratedTo = legacyPath, trustedDir
			return trustedDir + "/breeze-agent", nil
		},
		startDetached: func(script string) error {
			scheduledScript = script
			return nil
		},
	}

	migrateLegacyInstallIfNeeded(deps, "/Library/LaunchDaemons/com.breeze.agent.plist")

	if migratedFrom != "/usr/local/bin/breeze-agent" {
		t.Errorf("migrated from %q, want the legacy path", migratedFrom)
	}
	if migratedTo != "/Library/Breeze/bin" {
		t.Errorf("migrated to %q, want the trusted directory", migratedTo)
	}
	if !strings.Contains(scheduledScript, "/usr/local/bin/breeze-agent") ||
		!strings.Contains(scheduledScript, "/Library/Breeze/bin/breeze-agent") {
		t.Errorf("relocation script = %q, want it to reference both the old and new paths", scheduledScript)
	}
	if !strings.Contains(scheduledScript, "/Library/LaunchDaemons/com.breeze.agent.plist") {
		t.Errorf("relocation script = %q, want it to reference the plist path", scheduledScript)
	}
}

// TestMigrateLegacyInstallIfNeededNeverFailsStartupOnCopyError proves a
// failed copy is logged and swallowed, not propagated — this runs after the
// (warn-only) executable-trust check and must not turn that warning into a
// startup failure of its own.
func TestMigrateLegacyInstallIfNeededNeverFailsStartupOnCopyError(t *testing.T) {
	deps := migrateDarwinDeps{
		geteuid:    func() int { return 0 },
		executable: func() (string, error) { return "/usr/local/bin/breeze-agent", nil },
		migrate: func(string, string) (string, error) {
			return "", errors.New("disk full")
		},
		startDetached: func(string) error {
			t.Fatal("startDetached() must not be called when the copy failed")
			return nil
		},
	}
	// Must not panic and must return normally.
	migrateLegacyInstallIfNeeded(deps, "/Library/LaunchDaemons/com.breeze.agent.plist")
}
