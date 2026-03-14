package helper

import (
	"os"
	"path/filepath"
	"runtime"
)

// legacyBinaryPath returns the old "Breeze Helper" binary path.
func legacyBinaryPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Applications/Breeze Helper.app/Contents/MacOS/Breeze Helper"
	case "windows":
		pf := os.Getenv("ProgramFiles")
		if pf == "" {
			pf = `C:\Program Files`
		}
		return filepath.Join(pf, "Breeze Helper", "Breeze Helper.exe")
	default:
		return "/usr/local/bin/breeze-helper"
	}
}

// migrateFromLegacyName cleans up old "Breeze Helper" installations.
// Called at the top of Apply() under the manager mutex. Idempotent.
func (m *Manager) migrateFromLegacyName() {
	oldPath := legacyBinaryPath()
	if _, err := os.Stat(oldPath); err != nil {
		return
	}

	log.Info("migrating from legacy Breeze Helper installation", "oldPath", oldPath)

	// Platform-specific: stop old process + remove old autostart
	migrateLegacyPlatform()

	// Remove old binary/app bundle
	switch runtime.GOOS {
	case "darwin":
		os.RemoveAll("/Applications/Breeze Helper.app")
	case "windows":
		pf := os.Getenv("ProgramFiles")
		if pf == "" {
			pf = `C:\Program Files`
		}
		os.RemoveAll(filepath.Join(pf, "Breeze Helper"))
	default:
		os.Remove(oldPath)
	}

	log.Info("legacy Breeze Helper installation cleaned up")
}
