package ech

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCache_PutGetRoundTripsThroughDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ech-cache.json")
	want := []byte{0x00, 0x01, 0xfe, 0xff}
	NewCache(path).Put("api.example.com", ECHConfig{ConfigList: want, TTL: time.Hour})

	got, fresh, ok := NewCache(path).Get("api.example.com")
	if !ok || !fresh || !bytes.Equal(got, want) {
		t.Fatalf("Get = %v fresh=%v ok=%v; want %v fresh ok", got, fresh, ok, want)
	}
}

func TestCache_StaleAfterTTL(t *testing.T) {
	c := NewCache(filepath.Join(t.TempDir(), "c.json"))
	base := time.Unix(1_700_000_000, 0)
	c.now = func() time.Time { return base }
	c.Put("h", ECHConfig{ConfigList: []byte{1}, TTL: time.Minute})

	if _, fresh, ok := c.Get("h"); !ok || !fresh {
		t.Fatalf("before TTL: fresh=%v ok=%v", fresh, ok)
	}
	c.now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, fresh, ok := c.Get("h"); !ok || fresh {
		t.Fatalf("after TTL: fresh=%v ok=%v; want ok, stale", fresh, ok)
	}
}

func TestCache_CorruptFileIsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.json")
	if err := os.WriteFile(path, []byte("{garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := NewCache(path)
	if _, _, ok := c.Get("h"); ok {
		t.Fatal("corrupt file should yield an empty cache")
	}
	c.Put("h", ECHConfig{ConfigList: []byte{1}, TTL: time.Hour})
	if _, _, ok := NewCache(path).Get("h"); !ok {
		t.Fatal("cache should recover and persist after corrupt load")
	}
}

func TestCache_DeleteRemovesAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.json")
	c := NewCache(path)
	c.Put("a", ECHConfig{ConfigList: []byte{1}, TTL: time.Hour})
	c.Put("b", ECHConfig{ConfigList: []byte{2}, TTL: time.Hour})
	c.Delete("a")

	if _, _, ok := c.Get("a"); ok {
		t.Fatal("a still present in memory")
	}
	reloaded := NewCache(path)
	if _, _, ok := reloaded.Get("a"); ok {
		t.Fatal("a still present on disk")
	}
	if _, _, ok := reloaded.Get("b"); !ok {
		t.Fatal("b lost")
	}
}

func TestCache_GetReturnsCopyAndEmptyPathIsInMemory(t *testing.T) {
	c := NewCache("")
	c.Put("h", ECHConfig{ConfigList: []byte{1, 2}, TTL: time.Hour})
	got, _, _ := c.Get("h")
	got[0] = 9
	again, _, _ := c.Get("h")
	if again[0] != 1 {
		t.Fatal("Get aliases cache bytes")
	}
}

func TestCache_EmptyListIsNeverServed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ech-cache.json")
	c := NewCache(path)
	c.Put("api.example.com", ECHConfig{ConfigList: nil, TTL: time.Hour})
	if _, _, ok := c.Get("api.example.com"); ok {
		t.Fatal("Put stored an empty config list")
	}
	// An on-disk entry with an empty list (hand-edited or from an older
	// build) must load as absent, not as a usable config.
	if err := os.WriteFile(path, []byte(`{"api.example.com":{"configList":"","fetchedAt":"2026-01-01T00:00:00Z","ttlSeconds":86400000}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := NewCache(path).Get("api.example.com"); ok {
		t.Fatal("loaded an empty config list as usable")
	}
}

// TestCache_CorruptFileWarns: a corrupt cache file starts empty (as before)
// and says so once at Warn, naming the path.
func TestCache_CorruptFileWarns(t *testing.T) {
	logs := captureLogs(t)
	path := filepath.Join(t.TempDir(), "c.json")
	if err := os.WriteFile(path, []byte("{garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := NewCache(path).Get("h"); ok {
		t.Fatal("corrupt file should yield an empty cache")
	}
	if got := logs.lines("level=WARN", "ECH config cache corrupt; starting empty", path); len(got) != 1 {
		t.Fatalf("corrupt-cache warnings = %d, want 1; logs:\n%s", len(got), logs)
	}
}

// TestCache_UnreadableFileWarns: a read error other than not-exist starts
// empty and warns once; a missing file is the normal first boot and is quiet.
func TestCache_UnreadableFileWarns(t *testing.T) {
	logs := captureLogs(t)
	dir := t.TempDir() // a directory: ReadFile fails, and not with ErrNotExist
	if _, _, ok := NewCache(dir).Get("h"); ok {
		t.Fatal("unreadable file should yield an empty cache")
	}
	if got := logs.lines("level=WARN", "ECH config cache unreadable; starting empty", dir); len(got) != 1 {
		t.Fatalf("unreadable-cache warnings = %d, want 1; logs:\n%s", len(got), logs)
	}

	missing := filepath.Join(t.TempDir(), "absent.json")
	NewCache(missing)
	if got := logs.lines(missing); len(got) != 0 {
		t.Fatalf("missing file logged %v, want nothing", got)
	}
}
