package peripheral

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// newTestStore creates a Store that writes to a temp directory instead of
// relying on config.GetDataDir().
func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	return &Store{
		path: filepath.Join(dir, policiesFile),
	}
}

func TestStoreSaveAndLoad(t *testing.T) {
	s := newTestStore(t)

	policies := []Policy{
		{
			ID:          "pol-1",
			Name:        "Block USB storage",
			DeviceClass: "storage",
			Action:      "block",
			IsActive:    true,
			UpdatedAt:   "2026-01-15T10:00:00Z",
		},
		{
			ID:          "pol-2",
			Name:        "Alert on Bluetooth",
			DeviceClass: "bluetooth",
			Action:      "alert",
			IsActive:    true,
			UpdatedAt:   "2026-01-15T11:00:00Z",
		},
	}

	if err := s.Save(policies); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Create a new store pointing to the same file to verify disk persistence
	s2 := &Store{path: s.path}
	loaded, err := s2.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(loaded) != 2 {
		t.Fatalf("loaded %d policies, want 2", len(loaded))
	}
	if loaded[0].ID != "pol-1" {
		t.Fatalf("loaded[0].ID = %q, want %q", loaded[0].ID, "pol-1")
	}
	if loaded[0].Name != "Block USB storage" {
		t.Fatalf("loaded[0].Name = %q, want %q", loaded[0].Name, "Block USB storage")
	}
	if loaded[1].ID != "pol-2" {
		t.Fatalf("loaded[1].ID = %q, want %q", loaded[1].ID, "pol-2")
	}
}

func TestStoreLoadNonexistentReturnsNil(t *testing.T) {
	s := newTestStore(t)

	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load on nonexistent file should not error, got: %v", err)
	}
	if loaded != nil {
		t.Fatalf("Load on nonexistent file should return nil, got %d policies", len(loaded))
	}
}

func TestStorePoliciesReturnsInMemoryCopy(t *testing.T) {
	s := newTestStore(t)

	// Before Load or Save, Policies() returns nil
	if got := s.Policies(); got != nil {
		t.Fatalf("Policies() on empty store = %v, want nil", got)
	}

	policies := []Policy{
		{ID: "pol-1", Name: "Test", DeviceClass: "storage", Action: "block", IsActive: true},
	}
	if err := s.Save(policies); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got := s.Policies()
	if len(got) != 1 {
		t.Fatalf("Policies() returned %d, want 1", len(got))
	}
	if got[0].ID != "pol-1" {
		t.Fatalf("Policies()[0].ID = %q, want %q", got[0].ID, "pol-1")
	}
}

func TestStoreSaveOverwrites(t *testing.T) {
	s := newTestStore(t)

	first := []Policy{{ID: "pol-1", Name: "First", DeviceClass: "storage", Action: "block", IsActive: true}}
	if err := s.Save(first); err != nil {
		t.Fatalf("Save first: %v", err)
	}

	second := []Policy{
		{ID: "pol-2", Name: "Second", DeviceClass: "bluetooth", Action: "alert", IsActive: true},
		{ID: "pol-3", Name: "Third", DeviceClass: "thunderbolt", Action: "allow", IsActive: false},
	}
	if err := s.Save(second); err != nil {
		t.Fatalf("Save second: %v", err)
	}

	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded) != 2 {
		t.Fatalf("loaded %d policies, want 2 (should overwrite first save)", len(loaded))
	}
	if loaded[0].ID != "pol-2" {
		t.Fatalf("loaded[0].ID = %q, want %q", loaded[0].ID, "pol-2")
	}
}

func TestStoreSaveEmptySlice(t *testing.T) {
	s := newTestStore(t)

	// Save some policies first
	if err := s.Save([]Policy{{ID: "p1"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Now save empty slice
	if err := s.Save([]Policy{}); err != nil {
		t.Fatalf("Save empty: %v", err)
	}

	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("loaded %d policies after saving empty, want 0", len(loaded))
	}
}

func TestStoreSaveNil(t *testing.T) {
	s := newTestStore(t)

	if err := s.Save(nil); err != nil {
		t.Fatalf("Save nil: %v", err)
	}

	// nil marshals as JSON "null", Load should handle gracefully
	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load after nil save: %v", err)
	}
	if loaded != nil {
		t.Fatalf("loaded = %v after nil save, want nil", loaded)
	}
}

func TestStoreLoadCorruptedFile(t *testing.T) {
	s := newTestStore(t)

	// Write invalid JSON to the file
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(s.path, []byte("not valid json{{{"), 0600); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}

	_, err := s.Load()
	if err == nil {
		t.Fatal("Load should return error for corrupted JSON")
	}
}

func TestStoreSaveCreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	nestedPath := filepath.Join(dir, "sub", "dir", policiesFile)
	s := &Store{path: nestedPath}

	policies := []Policy{{ID: "pol-1", Name: "Test", IsActive: true}}
	if err := s.Save(policies); err != nil {
		t.Fatalf("Save with nested dirs: %v", err)
	}

	// Verify the file exists
	if _, err := os.Stat(nestedPath); os.IsNotExist(err) {
		t.Fatal("Save should create intermediate directories")
	}
}

func TestStoreSaveFilePermissions(t *testing.T) {
	s := newTestStore(t)

	if err := s.Save([]Policy{{ID: "p1"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(s.path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}

	// File should be 0600 (owner read/write only)
	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Fatalf("file permissions = %o, want 0600", perm)
	}
}

func TestStoreSaveAtomicity(t *testing.T) {
	s := newTestStore(t)

	// Save initial policies
	initial := []Policy{{ID: "pol-initial", Name: "Initial"}}
	if err := s.Save(initial); err != nil {
		t.Fatalf("Save initial: %v", err)
	}

	// Verify no .tmp file remains after successful save
	tmpPath := s.path + ".tmp"
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatal(".tmp file should not exist after successful save")
	}
}

func TestStoreJSONRoundTrip(t *testing.T) {
	s := newTestStore(t)

	policies := []Policy{
		{
			ID:          "pol-1",
			Name:        "Complex policy",
			DeviceClass: "storage",
			Action:      "block",
			TargetType:  "organization",
			TargetIDs: PolicyTargetIDs{
				SiteIDs:   []string{"site-1", "site-2"},
				GroupIDs:  []string{"grp-1"},
				DeviceIDs: []string{"dev-a", "dev-b", "dev-c"},
			},
			Exceptions: []ExceptionRule{
				{
					Vendor:       "SanDisk",
					Product:      "Ultra",
					SerialNumber: "SN001",
					Allow:        true,
					Reason:       "IT-approved",
					ExpiresAt:    "2027-01-01T00:00:00Z",
				},
			},
			IsActive:  true,
			UpdatedAt: "2026-03-13T12:00:00Z",
		},
	}

	if err := s.Save(policies); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Marshal both and compare
	origJSON, _ := json.Marshal(policies)
	loadedJSON, _ := json.Marshal(loaded)
	if string(origJSON) != string(loadedJSON) {
		t.Fatalf("JSON round-trip mismatch:\n  orig:   %s\n  loaded: %s", origJSON, loadedJSON)
	}
}

func TestStoreConcurrentAccess(t *testing.T) {
	s := newTestStore(t)

	var wg sync.WaitGroup

	// Concurrent saves
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			policies := []Policy{{ID: "pol-concurrent", Name: "Concurrent"}}
			_ = s.Save(policies)
		}(i)
	}

	// Concurrent reads
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = s.Policies()
		}()
	}

	wg.Wait()

	// Verify the store is in a consistent state
	loaded, err := s.Load()
	if err != nil {
		t.Fatalf("Load after concurrent access: %v", err)
	}
	if len(loaded) != 1 {
		t.Fatalf("expected 1 policy after concurrent access, got %d", len(loaded))
	}
}
