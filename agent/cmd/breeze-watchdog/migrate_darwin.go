//go:build darwin

package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// migrateDarwinDeps mirrors internal/agentapp's identical type; see there
// for the rationale.
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

// maybeMigrateLegacyInstall is the darwin entry point called from
// runWatchdog. Mirrors internal/agentapp's identical function for the
// agent binary; see there for the full rationale.
func maybeMigrateLegacyInstall() {
	migrateLegacyInstallIfNeeded(defaultMigrateDarwinDeps(), watchdogPlistDst)
}

func migrateLegacyInstallIfNeeded(deps migrateDarwinDeps, plistPath string) {
	if deps.geteuid() != 0 {
		return
	}
	self, err := deps.executable()
	if err != nil {
		slog.Warn("executable-trust migration: could not resolve own path", "error", err.Error())
		return
	}
	self = filepath.Clean(self)
	if filepath.Dir(self) != securefs.LegacyExecutableDir {
		return
	}
	newPath, err := deps.migrate(self, securefs.TrustedExecutableDir)
	if err != nil {
		slog.Warn("executable-trust migration: copy to trusted directory failed",
			"error", err.Error(), "legacyPath", self)
		return
	}
	script := buildDarwinRelocateScript(plistPath, self, newPath)
	if err := deps.startDetached(script); err != nil {
		slog.Warn("executable-trust migration: could not schedule service reload",
			"error", err.Error(), "newPath", newPath)
		return
	}
	slog.Warn("executable-trust migration: relocated to trusted directory, service reload scheduled",
		"from", self, "to", newPath)
}

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
// path with no shell metacharacters.
func shellQuote(path string) string {
	return "'" + path + "'"
}
