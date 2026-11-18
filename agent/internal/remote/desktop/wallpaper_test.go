package desktop

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
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

// useWallpaperStateDir points newWallpaperManager at dir for one test.
func useWallpaperStateDir(t *testing.T, dir string) {
	t.Helper()
	prev := wallpaperStateDir
	wallpaperStateDir = func() string { return dir }
	t.Cleanup(func() { wallpaperStateDir = prev })
}

// TestWallpaper_RecoveryRoundTripThroughStateDir is the #10870 crash path: a
// helper suppresses, dies without restoring, and the next process to build the
// manager finds the record in the same resolved directory and puts the
// wallpaper back. The per-user directory does not exist yet on a fresh login,
// so the writer must create it.
func TestWallpaper_RecoveryRoundTripThroughStateDir(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "Library", "Application Support", "Breeze")
	useWallpaperStateDir(t, stateDir)
	wantPath := filepath.Join(stateDir, wallpaperRecoveryFile)

	first := &stubWallpaperBackend{current: &WallpaperState{WallpaperPath: "/Users/canary/Pictures/beach.heic"}}
	crashed := newWallpaperManager(first)
	if crashed.recoveryPath != wantPath {
		t.Fatalf("writer recoveryPath = %q, want %q", crashed.recoveryPath, wantPath)
	}
	if err := crashed.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}
	if _, err := os.Stat(wantPath); err != nil {
		t.Fatalf("recovery file not written at %s: %v", wantPath, err)
	}
	// No Restore: the process "crashed" mid-session.

	second := &stubWallpaperBackend{}
	restarted := newWallpaperManager(second)
	if restarted.recoveryPath != wantPath {
		t.Fatalf("reader recoveryPath = %q, want the writer's %q", restarted.recoveryPath, wantPath)
	}
	if second.restoreCount != 1 {
		t.Fatalf("restarted manager Restore calls = %d, want 1", second.restoreCount)
	}
	if second.lastRestored == nil || second.lastRestored.WallpaperPath != "/Users/canary/Pictures/beach.heic" {
		t.Fatalf("restored state = %+v, want the suppressed wallpaper", second.lastRestored)
	}
	if _, err := os.Stat(wantPath); !os.IsNotExist(err) {
		t.Fatalf("recovery file should be removed after recovery, stat err = %v", err)
	}
}

// On a macOS user-session process the manager must resolve to the per-user
// state dir, not the root-only agent data dir it cannot write (#10870). Runs
// only where that resolution applies; the matrix itself is covered in config.
func TestWallpaper_RecoveryPathIsPerUserOnDarwin(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Geteuid() == 0 {
		t.Skip("per-user state dir applies to non-root macOS processes only")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)

	backend := &stubWallpaperBackend{}
	mgr := newWallpaperManager(backend)
	want := filepath.Join(home, "Library", "Application Support", "Breeze", wallpaperRecoveryFile)
	if mgr.recoveryPath != want {
		t.Fatalf("recoveryPath = %q, want %q", mgr.recoveryPath, want)
	}
	if err := mgr.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("recovery file not written at %s: %v", want, err)
	}
	if err := mgr.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
}

// A startup recovery whose Restore fails (on macOS: no main screen yet at
// login) must keep both the record and the saved wallpaper. Deleting the
// record, or letting the next Suppress capture the still-black desktop as
// "current", would lose the user's wallpaper for good (#10870 review).
func TestWallpaper_FailedRecoveryKeepsRecordAndOriginal(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "Library", "Application Support", "Breeze")
	useWallpaperStateDir(t, stateDir)
	recordPath := filepath.Join(stateDir, wallpaperRecoveryFile)

	crashed := newWallpaperManager(&stubWallpaperBackend{current: &WallpaperState{WallpaperPath: "/Users/canary/Pictures/beach.heic"}})
	if err := crashed.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}

	// Next start: the desktop is still black and Restore fails.
	failing := &stubWallpaperBackend{current: &WallpaperState{WallpaperPath: "/tmp/breeze_black_wallpaper.png"}, failRestore: true}
	restarted := newWallpaperManager(failing)
	if failing.restoreCount != 1 {
		t.Fatalf("recovery Restore calls = %d, want 1", failing.restoreCount)
	}
	if _, err := os.Stat(recordPath); err != nil {
		t.Fatalf("record must survive a failed recovery so the next start retries: %v", err)
	}

	// A session starts on the same process: the saved original, not the
	// black desktop, is what gets recorded and later restored.
	failing.failRestore = false
	if err := restarted.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}
	data, err := os.ReadFile(recordPath)
	if err != nil {
		t.Fatalf("read record: %v", err)
	}
	var saved WallpaperState
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatalf("decode record: %v", err)
	}
	if saved.WallpaperPath != "/Users/canary/Pictures/beach.heic" {
		t.Fatalf("record after Suppress = %q, want the original wallpaper", saved.WallpaperPath)
	}
	if err := restarted.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if failing.lastRestored == nil || failing.lastRestored.WallpaperPath != "/Users/canary/Pictures/beach.heic" {
		t.Fatalf("restored %+v, want the original wallpaper", failing.lastRestored)
	}
	if _, err := os.Stat(recordPath); !os.IsNotExist(err) {
		t.Fatalf("record should be removed after a successful restore, stat err = %v", err)
	}
}

// A record kept by a failed recovery is retried, and cleared, by the next
// process start.
func TestWallpaper_FailedRecoveryRetriedOnNextStart(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "Breeze")
	useWallpaperStateDir(t, stateDir)

	crashed := newWallpaperManager(&stubWallpaperBackend{current: &WallpaperState{WallpaperPath: "/Users/canary/Pictures/beach.heic"}})
	if err := crashed.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}
	_ = newWallpaperManager(&stubWallpaperBackend{failRestore: true})

	third := &stubWallpaperBackend{}
	_ = newWallpaperManager(third)
	if third.restoreCount != 1 || third.lastRestored == nil || third.lastRestored.WallpaperPath != "/Users/canary/Pictures/beach.heic" {
		t.Fatalf("next start should retry recovery of the original, got %d calls, %+v", third.restoreCount, third.lastRestored)
	}
	if _, err := os.Stat(filepath.Join(stateDir, wallpaperRecoveryFile)); !os.IsNotExist(err) {
		t.Fatalf("record should be removed after the retry succeeds, stat err = %v", err)
	}
}

// A session-end Restore that fails must not drop the original either: keep
// the record and the original so a later Suppress or start puts it back.
func TestWallpaper_FailedSessionRestoreKeepsOriginal(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "Breeze")
	useWallpaperStateDir(t, stateDir)
	recordPath := filepath.Join(stateDir, wallpaperRecoveryFile)

	backend := &stubWallpaperBackend{current: &WallpaperState{WallpaperPath: "/Users/canary/Pictures/beach.heic"}}
	mgr := newWallpaperManager(backend)
	if err := mgr.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}
	backend.failRestore = true
	if err := mgr.Restore(); err == nil {
		t.Fatal("Restore should report the backend failure")
	}
	if _, err := os.Stat(recordPath); err != nil {
		t.Fatalf("record must survive a failed session-end restore: %v", err)
	}

	// Next session on the same process: the original is still what is saved.
	backend.failRestore = false
	backend.current = &WallpaperState{WallpaperPath: "/tmp/breeze_black_wallpaper.png"}
	if err := mgr.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}
	if err := mgr.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if backend.lastRestored == nil || backend.lastRestored.WallpaperPath != "/Users/canary/Pictures/beach.heic" {
		t.Fatalf("restored %+v, want the original", backend.lastRestored)
	}
}

// A record whose restore keeps failing (say the original image was deleted)
// is dropped after a bounded number of starts instead of being retried, and
// pinned as the "original", forever.
func TestWallpaper_RecoveryGivesUpAfterMaxAttempts(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "Breeze")
	useWallpaperStateDir(t, stateDir)
	recordPath := filepath.Join(stateDir, wallpaperRecoveryFile)

	crashed := newWallpaperManager(&stubWallpaperBackend{current: &WallpaperState{WallpaperPath: "/gone.heic"}})
	if err := crashed.Suppress(); err != nil {
		t.Fatalf("Suppress: %v", err)
	}
	for i := 1; i <= maxWallpaperRecoveryAttempts; i++ {
		_ = newWallpaperManager(&stubWallpaperBackend{failRestore: true})
		_, err := os.Stat(recordPath)
		if i < maxWallpaperRecoveryAttempts && err != nil {
			t.Fatalf("record dropped after %d failed attempts, want it kept until %d", i, maxWallpaperRecoveryAttempts)
		}
		if i == maxWallpaperRecoveryAttempts && !os.IsNotExist(err) {
			t.Fatalf("record should be dropped after %d failed attempts, stat err = %v", i, err)
		}
	}
	last := newWallpaperManager(&stubWallpaperBackend{})
	if last.pendingRecovery != nil {
		t.Fatal("no pending original should remain after giving up")
	}
}
