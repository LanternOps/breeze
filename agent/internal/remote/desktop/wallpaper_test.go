package desktop

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// stubWallpaperBackend records calls for testing.
type stubWallpaperBackend struct {
	current       *WallpaperState
	setBlackCount int
	restoreCount  int
	lastRestored  *WallpaperState
	failSetBlack  bool
	failRestore   bool
}

func (s *stubWallpaperBackend) GetCurrent() (*WallpaperState, error) {
	if s.current != nil {
		cp := *s.current
		return &cp, nil
	}
	return &WallpaperState{WallpaperPath: "/test/wallpaper.png"}, nil
}

func (s *stubWallpaperBackend) SetSolidBlack() error {
	s.setBlackCount++
	if s.failSetBlack {
		return fmt.Errorf("SetSolidBlack failed")
	}
	return nil
}

func (s *stubWallpaperBackend) Restore(state *WallpaperState) error {
	s.restoreCount++
	s.lastRestored = state
	if s.failRestore {
		return fmt.Errorf("Restore failed")
	}
	return nil
}

func newTestManager(t *testing.T) (*WallpaperManager, *stubWallpaperBackend, string) {
	t.Helper()
	dir := t.TempDir()
	backend := &stubWallpaperBackend{}
	mgr := &WallpaperManager{
		backend:      backend,
		recoveryPath: filepath.Join(dir, "wallpaper_state.json"),
	}
	return mgr, backend, dir
}

func TestWallpaper_SuppressAndRestore(t *testing.T) {
	mgr, backend, _ := newTestManager(t)

	if err := mgr.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}
	if backend.setBlackCount != 1 {
		t.Fatalf("expected 1 SetSolidBlack call, got %d", backend.setBlackCount)
	}

	if err := mgr.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if backend.restoreCount != 1 {
		t.Fatalf("expected 1 Restore call, got %d", backend.restoreCount)
	}
}

func TestWallpaper_RefCounting(t *testing.T) {
	mgr, backend, _ := newTestManager(t)

	// Suppress twice
	mgr.Suppress()
	mgr.Suppress()
	if backend.setBlackCount != 1 {
		t.Fatalf("expected 1 SetSolidBlack, got %d", backend.setBlackCount)
	}

	// First restore — still active
	mgr.Restore()
	if backend.restoreCount != 0 {
		t.Fatalf("expected 0 Restore calls (still suppressed), got %d", backend.restoreCount)
	}

	// Second restore — actually restores
	mgr.Restore()
	if backend.restoreCount != 1 {
		t.Fatalf("expected 1 Restore call, got %d", backend.restoreCount)
	}
}

func TestWallpaper_DoubleRestore(t *testing.T) {
	mgr, backend, _ := newTestManager(t)

	mgr.Suppress()
	mgr.Restore()
	mgr.Restore() // extra — should be idempotent
	mgr.Restore() // extra — should be idempotent

	if backend.restoreCount != 1 {
		t.Fatalf("expected 1 Restore call (idempotent), got %d", backend.restoreCount)
	}
}

func TestWallpaper_CrashRecovery(t *testing.T) {
	dir := t.TempDir()
	recoveryPath := filepath.Join(dir, "wallpaper_state.json")

	// Simulate a crash: write recovery file
	state := WallpaperState{
		WallpaperPath: "/test/original.png",
		Suppressed:    true,
	}
	data, _ := json.Marshal(state)
	os.WriteFile(recoveryPath, data, 0600)

	backend := &stubWallpaperBackend{}
	mgr := &WallpaperManager{
		backend:      backend,
		recoveryPath: recoveryPath,
	}
	mgr.recoverIfNeeded()

	if backend.restoreCount != 1 {
		t.Fatalf("expected crash recovery restore, got %d calls", backend.restoreCount)
	}
	if backend.lastRestored == nil || backend.lastRestored.WallpaperPath != "/test/original.png" {
		t.Fatalf("wrong recovery state: %+v", backend.lastRestored)
	}

	// Recovery file should be deleted
	if _, err := os.Stat(recoveryPath); !os.IsNotExist(err) {
		t.Fatal("recovery file should be deleted after recovery")
	}
}

func TestWallpaper_RecoveryFileWritten(t *testing.T) {
	mgr, _, _ := newTestManager(t)

	mgr.Suppress()

	// Recovery file should exist
	data, err := os.ReadFile(mgr.recoveryPath)
	if err != nil {
		t.Fatalf("recovery file not written: %v", err)
	}
	var state WallpaperState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("invalid recovery file: %v", err)
	}
	if !state.Suppressed {
		t.Fatal("recovery state should be suppressed")
	}
}

func TestWallpaper_SetBlackFails(t *testing.T) {
	mgr, backend, _ := newTestManager(t)
	backend.failSetBlack = true

	err := mgr.Suppress()
	if err == nil {
		t.Fatal("expected error when SetSolidBlack fails")
	}

	// RefCount should be rolled back
	mgr.mu.Lock()
	rc := mgr.refCount
	mgr.mu.Unlock()
	if rc != 0 {
		t.Fatalf("refCount should be 0 after failed suppress, got %d", rc)
	}
}
