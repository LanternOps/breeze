//go:build darwin

package agentapp

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// migrateDarwinDeps lets migrateLegacyInstallIfNeeded's decision logic be
// unit tested without touching the real filesystem, spawning a real
// process, or needing root.
type migrateDarwinDeps struct {
	geteuid       func() int
	executable    func() (string, error)
	migrate       func(legacyPath, trustedDir string) (string, error)
	startDetached func(script string) error
}

func defaultMigrateDarwinDeps() migrateDarwinDeps {
	return migrateDarwinDeps{
		geteuid:    os.Geteuid,
		executable: os.Executable,
		migrate: func(legacyPath, trustedDir string) (string, error) {
			return securefs.MigrateExecutableToTrustedDir(nil, legacyPath, trustedDir)
		},
		startDetached: func(script string) error {
			cmd := exec.Command("/bin/sh", "-c", script)
			cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if err := cmd.Start(); err != nil {
				return err
			}
			return cmd.Process.Release()
		},
	}
}

// maybeMigrateLegacyInstall is the darwin entry point called from runAgent.
// It never blocks or fails startup — every error is logged and swallowed —
// because it runs after the (currently warn-only)
// verifyOwnExecutableTrustedIfPrivileged check and must not turn a logged
// warning into a hang or a crash.
func maybeMigrateLegacyInstall() {
	migrateLegacyInstallIfNeeded(defaultMigrateDarwinDeps(), darwinPlistDst)
}

// migrateLegacyInstallIfNeeded moves a privileged agent still running from
// securefs.LegacyExecutableDir ("/usr/local/bin") into the root-owned,
// Breeze-only securefs.TrustedExecutableDir, then schedules a reload of the
// launchd service from the new location.
//
// It only acts when actually privileged (geteuid 0) and only when this
// process's own executable is directly inside the legacy directory — an
// unprivileged dev/test run, or an install that's already on the trusted
// path, is a no-op. The relaunch runs from a detached shell (same technique
// as the agent's own self-uninstall path, internal/heartbeat) because
// unloading our own LaunchDaemon plist kills this process; we cannot do
// that unload ourselves and expect to observe its result.
func migrateLegacyInstallIfNeeded(deps migrateDarwinDeps, plistPath string) {
	if deps.geteuid() != 0 {
		return
	}
	self, err := deps.executable()
	if err != nil {
		log.Warn("executable-trust migration: could not resolve own path", "error", err.Error())
		return
	}
	self = filepath.Clean(self)
	if filepath.Dir(self) != securefs.LegacyExecutableDir {
		return
	}
	newPath, err := deps.migrate(self, securefs.TrustedExecutableDir)
	if err != nil {
		log.Warn("executable-trust migration: copy to trusted directory failed",
			"error", err.Error(), "legacyPath", self)
		return
	}
	script := buildDarwinRelocateScript(plistPath, self, newPath)
	if err := deps.startDetached(script); err != nil {
		log.Warn("executable-trust migration: could not schedule service reload",
			"error", err.Error(), "newPath", newPath)
		return
	}
	log.Warn("executable-trust migration: relocated to trusted directory, service reload scheduled",
		"from", self, "to", newPath)
}

// buildDarwinRelocateScript renders the detached shell that repoints
// plistPath's ProgramArguments at newPath and reloads the launchd service.
// It sleeps briefly first so the caller's own startup (which continues
// running from oldPath under the warn-only trust check) has a moment to
// reach a stable state before this pulls the rug out from under it.
func buildDarwinRelocateScript(plistPath, oldPath, newPath string) string {
	return fmt.Sprintf(
		"sleep 2\n"+
			"/usr/bin/sed -i '' 's|%s|%s|' %s\n"+
			"/bin/launchctl unload %s 2>/dev/null || true\n"+
			"/bin/launchctl load %s 2>/dev/null || true\n",
		oldPath, newPath, shellQuote(plistPath), shellQuote(plistPath), shellQuote(plistPath))
}

// shellQuote wraps path in single quotes for embedding in the detached
// relocate script. Every call site passes a compile-time constant plist
// path with no shell metacharacters; this exists so that remains true by
// construction rather than by convention.
func shellQuote(path string) string {
	return "'" + path + "'"
}
