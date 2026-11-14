package providers

import (
	"os"
	"path/filepath"
	"testing"
)

// ObjectSizes reports every object under a prefix from one walk through one
// store root, and refuses the same paths every other operation refuses.
func TestLocalStoreObjectSizes(t *testing.T) {
	root, other := privateStoreTempDir(t), t.TempDir()
	p := NewLocalProvider(root)
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	keys := []string{"snapshots/s1/a", "snapshots/s1/b", "snapshots/s1/files/c", "snapshots/s2/d"}
	for _, key := range keys {
		if err := p.Upload(source, key); err != nil {
			t.Fatal(err)
		}
	}
	opens := 0
	setOpenStoreRootForTest(t, func(name string) (*os.Root, error) { opens++; return os.OpenRoot(name) })

	sizes, err := p.ObjectSizes("snapshots/s1")
	if err != nil {
		t.Fatal(err)
	}
	if opens != 1 {
		t.Fatalf("store opened %d times for one listing, want 1", opens)
	}
	want := map[string]int64{"snapshots/s1/a": 7, "snapshots/s1/b": 7, "snapshots/s1/files/c": 7}
	if len(sizes) != len(want) {
		t.Fatalf("sizes = %v, want %v", sizes, want)
	}
	for key, size := range want {
		if sizes[key] != size {
			t.Fatalf("sizes = %v, want %v", sizes, want)
		}
	}
	if missing, err := p.ObjectSizes("snapshots/none"); err != nil || len(missing) != 0 {
		t.Fatalf("missing prefix: %v %v", missing, err)
	}
	if _, err := p.ObjectSizes("../outside"); err == nil {
		t.Fatal("expected a prefix outside the store to be refused")
	}
	if err := os.WriteFile(filepath.Join(other, "data"), []byte("outside content"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(root, "snapshots", "s1", "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := p.ObjectSizes("snapshots/s1"); err == nil {
		t.Fatal("expected a link under the prefix to be refused")
	}
}
