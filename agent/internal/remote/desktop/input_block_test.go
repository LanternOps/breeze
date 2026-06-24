package desktop

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

// stubInputBlockBackend records calls for testing the manager state machine.
type stubInputBlockBackend struct {
	mu           sync.Mutex
	supported    bool
	blockCount   int
	unblockCount int
	failBlock    bool
	failUnblock  bool
	blocked      bool
}

func (s *stubInputBlockBackend) Supported() bool { return s.supported }

func (s *stubInputBlockBackend) Block() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blockCount++
	if s.failBlock {
		return fmt.Errorf("Block failed")
	}
	s.blocked = true
	return nil
}

func (s *stubInputBlockBackend) Unblock() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unblockCount++
	if s.failUnblock {
		return fmt.Errorf("Unblock failed")
	}
	s.blocked = false
	return nil
}

func (s *stubInputBlockBackend) counts() (block, unblock int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.blockCount, s.unblockCount
}

func newTestInputBlockManager(backend *stubInputBlockBackend) *InputBlockManager {
	return &InputBlockManager{
		backend:     backend,
		now:         time.Now,
		maxDuration: time.Hour, // long enough that the watchdog never fires in tests
	}
}

func TestInputBlock_EngageAndRelease(t *testing.T) {
	backend := &stubInputBlockBackend{supported: true}
	mgr := newTestInputBlockManager(backend)

	supported, err := mgr.Engage()
	if err != nil {
		t.Fatalf("Engage: %v", err)
	}
	if !supported {
		t.Fatal("expected supported=true")
	}
	if !mgr.IsEngaged() {
		t.Fatal("expected manager engaged after Engage")
	}
	if b, _ := backend.counts(); b != 1 {
		t.Fatalf("expected 1 Block call, got %d", b)
	}

	if err := mgr.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if mgr.IsEngaged() {
		t.Fatal("expected manager not engaged after Release")
	}
	if _, u := backend.counts(); u != 1 {
		t.Fatalf("expected 1 Unblock call, got %d", u)
	}
}

func TestInputBlock_RefCounting(t *testing.T) {
	backend := &stubInputBlockBackend{supported: true}
	mgr := newTestInputBlockManager(backend)

	// Two sessions engage.
	mgr.Engage()
	mgr.Engage()
	if b, _ := backend.counts(); b != 1 {
		t.Fatalf("expected 1 Block call across two Engage calls, got %d", b)
	}

	// First release — still engaged.
	mgr.Release()
	if _, u := backend.counts(); u != 0 {
		t.Fatalf("expected 0 Unblock calls while a session still holds the block, got %d", u)
	}
	if !mgr.IsEngaged() {
		t.Fatal("expected still engaged after first of two releases")
	}

	// Second release — actually unblocks.
	mgr.Release()
	if _, u := backend.counts(); u != 1 {
		t.Fatalf("expected 1 Unblock call after final release, got %d", u)
	}
	if mgr.IsEngaged() {
		t.Fatal("expected not engaged after final release")
	}
}

func TestInputBlock_DoubleReleaseIdempotent(t *testing.T) {
	backend := &stubInputBlockBackend{supported: true}
	mgr := newTestInputBlockManager(backend)

	mgr.Engage()
	mgr.Release()
	mgr.Release() // extra — must be a no-op, never go negative or double-unblock
	mgr.Release()

	if _, u := backend.counts(); u != 1 {
		t.Fatalf("expected exactly 1 Unblock call (idempotent), got %d", u)
	}
}

func TestInputBlock_Unsupported(t *testing.T) {
	backend := &stubInputBlockBackend{supported: false}
	mgr := newTestInputBlockManager(backend)

	supported, err := mgr.Engage()
	if err != nil {
		t.Fatalf("Engage on unsupported platform should not error: %v", err)
	}
	if supported {
		t.Fatal("expected supported=false")
	}
	if mgr.IsEngaged() {
		t.Fatal("unsupported platform must not engage")
	}
	if b, _ := backend.counts(); b != 0 {
		t.Fatalf("expected 0 Block calls on unsupported platform, got %d", b)
	}

	// Release on unsupported is a safe no-op.
	if err := mgr.Release(); err != nil {
		t.Fatalf("Release on unsupported should not error: %v", err)
	}
}

func TestInputBlock_BlockFailsRollsBackRefcount(t *testing.T) {
	backend := &stubInputBlockBackend{supported: true, failBlock: true}
	mgr := newTestInputBlockManager(backend)

	supported, err := mgr.Engage()
	if !supported {
		t.Fatal("platform is supported even though Block failed; expected supported=true")
	}
	if err == nil {
		t.Fatal("expected error when Block fails")
	}
	if mgr.IsEngaged() {
		t.Fatal("manager must not report engaged after a failed Block")
	}

	mgr.mu.Lock()
	rc := mgr.refCount
	mgr.mu.Unlock()
	if rc != 0 {
		t.Fatalf("refCount must roll back to 0 after failed Block, got %d", rc)
	}
}

func TestInputBlock_WatchdogForceReleases(t *testing.T) {
	backend := &stubInputBlockBackend{supported: true}
	mgr := &InputBlockManager{
		backend:     backend,
		now:         time.Now,
		maxDuration: 30 * time.Millisecond, // fire quickly
	}

	if _, err := mgr.Engage(); err != nil {
		t.Fatalf("Engage: %v", err)
	}
	// Do NOT release — let the safety watchdog fire.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !mgr.IsEngaged() {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if mgr.IsEngaged() {
		t.Fatal("watchdog should have force-released the block after maxDuration")
	}
	if _, u := backend.counts(); u != 1 {
		t.Fatalf("expected watchdog to call Unblock exactly once, got %d", u)
	}

	// A subsequent explicit Release must remain a safe no-op (refcount already 0).
	if err := mgr.Release(); err != nil {
		t.Fatalf("Release after watchdog should be a no-op: %v", err)
	}
	if _, u := backend.counts(); u != 1 {
		t.Fatalf("Release after watchdog must not double-unblock, got %d unblocks", u)
	}
}

func TestInputBlock_NormalReleaseStopsWatchdog(t *testing.T) {
	backend := &stubInputBlockBackend{supported: true}
	mgr := &InputBlockManager{
		backend:     backend,
		now:         time.Now,
		maxDuration: 40 * time.Millisecond,
	}

	mgr.Engage()
	// Release well before the watchdog deadline.
	if err := mgr.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	// Wait past the watchdog deadline; it must not fire a second unblock.
	time.Sleep(80 * time.Millisecond)
	if _, u := backend.counts(); u != 1 {
		t.Fatalf("watchdog must not fire after a normal release; expected 1 Unblock, got %d", u)
	}
}
