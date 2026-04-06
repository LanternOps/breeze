package helper

import (
	"os"
	"path/filepath"
	"runtime"
)

var (
	removeAutoStartFunc   = removeAutoStart
	stopHelperLegacyFunc  = stopHelperLegacy
	migrationTargetsFunc  = migrationTargets
	prepareSessionDirFunc = prepareSessionDir
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
	migrateLegacyPlatform()

	switch runtime.GOOS {
	case "darwin":
		_ = os.RemoveAll("/Applications/Breeze Helper.app")
	case "windows":
		pf := os.Getenv("ProgramFiles")
		if pf == "" {
			pf = `C:\Program Files`
		}
		_ = os.RemoveAll(filepath.Join(pf, "Breeze Helper"))
	default:
		_ = os.Remove(oldPath)
	}

	log.Info("legacy Breeze Helper installation cleaned up")
}

func (m *Manager) needsSessionMigration() bool {
	_, err := os.Stat(filepath.Join(m.baseDir, "sessions"))
	return os.IsNotExist(err)
}

// migrateToSessions performs the one-time migration from global config to per-session layout.
// Called with the manager mutex held.
func (m *Manager) migrateToSessions() {
	log.Info("migrating to per-session Assist layout")

	sessionsDir := filepath.Join(m.baseDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		log.Error("failed to create sessions dir", "error", err.Error())
		return
	}

	globalConfig, _ := os.ReadFile(m.legacyConfigPath())
	configName := filepath.Base(m.legacyConfigPath())

	targets := make([]string, 0)
	seen := make(map[string]struct{})
	addTarget := func(key string) {
		if key == "" {
			return
		}
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		targets = append(targets, key)
	}

	if m.sessionEnumerator != nil {
		for _, si := range m.sessionEnumerator.ActiveSessions() {
			addTarget(si.Key)
		}
	}
	if extraTargets, err := migrationTargetsFunc(); err != nil {
		log.Warn("failed to discover migration targets", "error", err.Error())
	} else {
		for _, key := range extraTargets {
			addTarget(key)
		}
	}

	for _, key := range targets {
		sessionDir := filepath.Join(sessionsDir, key)
		if err := os.MkdirAll(sessionDir, 0755); err != nil {
			log.Warn("failed to create session dir", "session", key, "error", err.Error())
			continue
		}
		if err := prepareSessionDirFunc(sessionDir, key); err != nil {
			log.Warn("failed to prepare session dir", "session", key, "error", err.Error())
		}
		if len(globalConfig) > 0 {
			if err := os.WriteFile(filepath.Join(sessionDir, configName), globalConfig, 0644); err != nil {
				log.Warn("failed to copy legacy config", "session", key, "error", err.Error())
			}
		}
	}

	if err := removeAutoStartFunc(); err != nil {
		log.Warn("failed to remove legacy autostart", "error", err.Error())
	}
	stopHelperGlobal()
	log.Info("per-session migration complete")
}

func stopHelperGlobal() {
	stopHelperLegacyFunc()
}
