//go:build windows

package providers

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// A junction already present inside the store is refused by every operation
// and nothing it points at is read, written or removed.
func TestLocalStoreRefusesJunctionInsideStore(t *testing.T) {
	for _, operation := range localStoreOperations {
		t.Run(operation, func(t *testing.T) {
			root, other := privateStoreTempDir(t), t.TempDir()
			if err := os.WriteFile(filepath.Join(other, "data"), []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := securefs.InstallJunction(root, "objects", other, 0); err != nil {
				t.Fatalf("create junction: %v", err)
			}
			source := filepath.Join(t.TempDir(), "source")
			if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(t.TempDir(), "result")

			if err := runLocalStoreOperation(NewLocalProvider(root), operation, source, "objects/data", output); err == nil {
				t.Fatal("expected the junction inside the store to be refused")
			}
			got, err := os.ReadFile(filepath.Join(other, "data"))
			if err != nil || string(got) != "keep" {
				t.Fatalf("junction target changed: %q %v", got, err)
			}
			entries, err := os.ReadDir(other)
			if err != nil || len(entries) != 1 {
				t.Fatalf("junction target directory changed: %v %v", entries, err)
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("download produced output through a junction: %v", err)
			}
		})
	}
}

// A store root that is itself a junction is refused.
func TestLocalStoreRefusesJunctionRoot(t *testing.T) {
	real := privateStoreTempDir(t)
	parent := t.TempDir()
	if _, err := securefs.InstallJunction(parent, "store", real, 0); err != nil {
		t.Fatalf("create junction: %v", err)
	}
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NewLocalProvider(filepath.Join(parent, "store")).Upload(source, "objects/data"); err == nil {
		t.Fatal("expected a junction store root to be refused")
	}
	if _, err := os.Stat(filepath.Join(real, "objects")); !os.IsNotExist(err) {
		t.Fatalf("junction target changed: %v", err)
	}
}
