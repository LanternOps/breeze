package desktop

import (
	"encoding/json"
	"errors"
	"io/fs"
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
	// pendingRecovery is a crash-recovery record whose startup Restore
	// failed (on macOS, no main screen yet at login). The record file is
	// kept so the next start retries, and the next Suppress saves this
	// original instead of capturing the still-black desktop as "current".
	pendingRecovery *WallpaperState
}

var (
	wallpaperMgrOnce     sync.Once
	wallpaperMgrInstance *WallpaperManager
)

// wallpaperRecoveryFile is the crash-recovery record's name inside the
// process's state dir.
const wallpaperRecoveryFile = "wallpaper_state.json"

// wallpaperStateDir resolves where the recovery record lives. It is the
// process's own state dir, not the agent data dir: on macOS the wallpaper is
// suppressed and restored by the user-session desktop helper, which runs as
// the console user and cannot write the root-only data dir (#10870), so its
// record lives under ~/Library/Application Support/Breeze. Every process
// that writes the record also reads it back on its next start through this
// same resolver. Swapped in tests.
var wallpaperStateDir = config.ProcessDataDir

// GetWallpaperManager returns the package-level singleton WallpaperManager.
// On first call, it checks for a leftover recovery file and restores the
// wallpaper if this process (or an earlier run of it) crashed mid-session.
func GetWallpaperManager() *WallpaperManager {
	wallpaperMgrOnce.Do(func() {
		wallpaperMgrInstance = newWallpaperManager(newWallpaperBackend())
	})
	return wallpaperMgrInstance
}

// newWallpaperManager builds a manager whose recovery record lives in the
// resolved state dir and runs crash recovery from it.
func newWallpaperManager(backend wallpaperBackend) *WallpaperManager {
	mgr := &WallpaperManager{
		backend:      backend,
		recoveryPath: filepath.Join(wallpaperStateDir(), wallpaperRecoveryFile),
	}
	mgr.recoverIfNeeded()
	return mgr
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

	var state *WallpaperState
	if m.pendingRecovery != nil {
		// The desktop is still the black we set before a crash: the
		// original is the one recovery could not put back.
		cp := *m.pendingRecovery
		state = &cp
	} else {
		var err error
		state, err = m.backend.GetCurrent()
		if err != nil {
			m.refCount--
			return err
		}
	}
	state.Suppressed = true
	m.savedState = state

	if err := m.writeRecoveryFile(state); err != nil {
		slog.Warn("Failed to write wallpaper recovery file", "error", err.Error())
		// Continue — suppression still works, just no crash recovery
	}

	if err := m.backend.SetSolidBlack(); err != nil {
		m.refCount--
		m.savedState = nil
		if m.pendingRecovery != nil {
			// Keep the record: it still describes the original that a
			// crash left unrestored.
			_ = m.writeRecoveryFile(m.pendingRecovery)
		} else {
			_ = m.deleteRecoveryFile()
		}
		return err
	}
	m.pendingRecovery = nil

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
// restores the wallpaper if found. A failed Restore keeps the record (the
// next start retries) and remembers the original for the next Suppress.
func (m *WallpaperManager) recoverIfNeeded() {
	data, err := os.ReadFile(m.recoveryPath)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("Wallpaper recovery record unreadable; a wallpaper left black by a crash will not be restored",
				"path", m.recoveryPath, "error", err.Error())
		}
		return // no recovery file — normal startup
	}

	var state WallpaperState
	if err := json.Unmarshal(data, &state); err != nil {
		slog.Warn("Invalid wallpaper recovery file, removing", "error", err.Error())
		m.removeRecoveryRecord()
		return
	}

	if !state.Suppressed {
		m.removeRecoveryRecord()
		return
	}

	slog.Info("Recovering wallpaper from previous crash", "path", state.WallpaperPath)
	if err := m.backend.Restore(&state); err != nil {
		slog.Warn("Failed to recover wallpaper; keeping the record to retry on the next start",
			"path", m.recoveryPath, "error", err.Error())
		m.pendingRecovery = &state
		return
	}
	slog.Info("Wallpaper recovered from previous crash")
	m.removeRecoveryRecord()
}

// removeRecoveryRecord deletes the record, warning when it cannot: a record
// that will not go away is re-restored on every start.
func (m *WallpaperManager) removeRecoveryRecord() {
	if err := os.Remove(m.recoveryPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("Failed to remove wallpaper recovery record", "path", m.recoveryPath, "error", err.Error())
	}
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
