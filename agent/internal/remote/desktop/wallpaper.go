package desktop

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/breeze-rmm/agent/internal/config"
)

// wallpaperBackend is the platform-specific interface for wallpaper manipulation.
type wallpaperBackend interface {
	GetCurrent() (*WallpaperState, error)
	SetSolidBlack() error
	Restore(state *WallpaperState) error
}

// WallpaperState holds the saved wallpaper state for restoration and crash recovery.
type WallpaperState struct {
	WallpaperPath string `json:"wallpaperPath"`
	DesktopEnv    string `json:"desktopEnv,omitempty"` // Linux only
	Suppressed    bool   `json:"suppressed"`
}

// WallpaperManager provides refcounted wallpaper suppression with crash recovery.
type WallpaperManager struct {
	mu           sync.Mutex
	refCount     int
	savedState   *WallpaperState
	backend      wallpaperBackend
	recoveryPath string
}

var (
	wallpaperMgrOnce     sync.Once
	wallpaperMgrInstance *WallpaperManager
)

// GetWallpaperManager returns the package-level singleton WallpaperManager.
// On first call, it checks for a leftover recovery file and restores the
// wallpaper if the agent crashed mid-session.
func GetWallpaperManager() *WallpaperManager {
	wallpaperMgrOnce.Do(func() {
		recoveryPath := filepath.Join(config.GetDataDir(), "wallpaper_state.json")
		mgr := &WallpaperManager{
			backend:      newWallpaperBackend(),
			recoveryPath: recoveryPath,
		}
		mgr.recoverIfNeeded()
		wallpaperMgrInstance = mgr
	})
	return wallpaperMgrInstance
}

// Suppress suppresses the desktop wallpaper to solid black. Reference-counted:
// the first call saves the current wallpaper and sets solid black; subsequent
// calls only increment the counter.
func (m *WallpaperManager) Suppress() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.refCount++
	if m.refCount > 1 {
		return nil // already suppressed
	}

	state, err := m.backend.GetCurrent()
	if err != nil {
		m.refCount--
		return err
	}
	state.Suppressed = true
	m.savedState = state

	if err := m.writeRecoveryFile(state); err != nil {
		slog.Warn("Failed to write wallpaper recovery file", "error", err)
		// Continue — suppression still works, just no crash recovery
	}

	if err := m.backend.SetSolidBlack(); err != nil {
		m.refCount--
		m.savedState = nil
		_ = m.deleteRecoveryFile()
		return err
	}

	slog.Info("Wallpaper suppressed to solid black")
	return nil
}

// Restore restores the original wallpaper. Reference-counted: only restores
// when all sessions have called Restore. Idempotent if already at refcount 0.
func (m *WallpaperManager) Restore() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.refCount <= 0 {
		m.refCount = 0
		return nil
	}

	m.refCount--
	if m.refCount > 0 {
		return nil // other sessions still active
	}

	if m.savedState == nil {
		_ = m.deleteRecoveryFile()
		return nil
	}

	err := m.backend.Restore(m.savedState)
	m.savedState = nil
	_ = m.deleteRecoveryFile()

	if err != nil {
		return err
	}

	slog.Info("Wallpaper restored")
	return nil
}

// recoverIfNeeded checks for a leftover recovery file from a crash and
// restores the wallpaper if found.
func (m *WallpaperManager) recoverIfNeeded() {
	data, err := os.ReadFile(m.recoveryPath)
	if err != nil {
		return // no recovery file — normal startup
	}

	var state WallpaperState
	if err := json.Unmarshal(data, &state); err != nil {
		slog.Warn("Invalid wallpaper recovery file, removing", "error", err)
		_ = os.Remove(m.recoveryPath)
		return
	}

	if !state.Suppressed {
		_ = os.Remove(m.recoveryPath)
		return
	}

	slog.Info("Recovering wallpaper from previous crash", "path", state.WallpaperPath)
	if err := m.backend.Restore(&state); err != nil {
		slog.Warn("Failed to recover wallpaper", "error", err)
	}
	_ = os.Remove(m.recoveryPath)
}

func (m *WallpaperManager) writeRecoveryFile(state *WallpaperState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	dir := filepath.Dir(m.recoveryPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return os.WriteFile(m.recoveryPath, data, 0600)
}

func (m *WallpaperManager) deleteRecoveryFile() error {
	return os.Remove(m.recoveryPath)
}
