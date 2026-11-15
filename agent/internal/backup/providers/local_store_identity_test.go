package providers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setOpenStoreRootForTest(t *testing.T, fn func(string) (*os.Root, error)) {
	t.Helper()
	old := openStoreRoot
	openStoreRoot = fn
	t.Cleanup(func() { openStoreRoot = old })
}

// Operations run only through a root that is the verified store directory:
// if opening the store yields any other directory, every operation is
// refused and neither directory is read or changed.
func TestLocalStoreUsesOnlyTheVerifiedDirectory(t *testing.T) {
	for _, operation := range localStoreOperations {
		t.Run(operation, func(t *testing.T) {
			store, other := privateStoreTempDir(t), privateStoreTempDir(t)
			for _, dir := range []string{store, other} {
				if err := os.MkdirAll(filepath.Join(dir, "objects"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "objects", "data"), []byte("keep"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			setOpenStoreRootForTest(t, func(string) (*os.Root, error) { return os.OpenRoot(other) })
			source := filepath.Join(t.TempDir(), "source")
			if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(t.TempDir(), "result")

			err := runLocalStoreOperation(NewLocalProvider(store), operation, source, "objects/data", output)
			if err == nil || !strings.Contains(err.Error(), "changed while opening") {
				t.Fatalf("expected the store identity check to refuse, got %v", err)
			}
			for _, dir := range []string{store, other} {
				got, err := os.ReadFile(filepath.Join(dir, "objects", "data"))
				if err != nil || string(got) != "keep" {
					t.Fatalf("object in %s changed: %q %v", dir, got, err)
				}
				entries, err := os.ReadDir(filepath.Join(dir, "objects"))
				if err != nil || len(entries) != 1 {
					t.Fatalf("directory %s changed: %v %v", dir, entries, err)
				}
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("download produced output: %v", err)
			}
		})
	}
}

// Prepare creates a missing store owner-only and refuses an existing one that
// is not private, with operator guidance.
func TestLocalStorePrepare(t *testing.T) {
	root := filepath.Join(t.TempDir(), "store")
	if err := NewLocalProvider(root).Prepare(); err != nil {
		t.Fatalf("Prepare on a new root: %v", err)
	}
	if err := NewLocalProvider(root).Prepare(); err != nil {
		t.Fatalf("Prepare on an existing private root: %v", err)
	}
	if err := NewLocalProvider("").Prepare(); err == nil {
		t.Fatal("Prepare with no base path must fail")
	}
}
