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
