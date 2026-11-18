package providers

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func runLocalStoreOperation(p *LocalProvider, operation, source, key, output string) error {
	switch operation {
	case "upload":
		return p.Upload(source, key)
	case "digest":
		_, err := p.UploadWithDigest(context.Background(), source, key)
		return err
	case "download":
		return p.Download(key, output)
	case "delete":
		return p.Delete(key)
	case "list":
		_, err := p.List(key)
		return err
	case "sweep":
		_, err := p.SweepStaleUploads(key, time.Second)
		return err
	}
	panic("unknown operation " + operation)
}

var localStoreOperations = []string{"upload", "digest", "download", "delete", "list", "sweep"}

// A link that already exists inside the store, at a parent directory or at
// the object itself, is refused by every operation and nothing outside the
// store is read, written or removed.
func TestLocalStoreRefusesLinksInsideStore(t *testing.T) {
	for _, shape := range []string{"parent", "object"} {
		for _, operation := range localStoreOperations {
			t.Run(shape+"/"+operation, func(t *testing.T) {
				root, other := privateStoreTempDir(t), t.TempDir()
				p := NewLocalProvider(root)
				source := filepath.Join(t.TempDir(), "source")
				if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(other, "data"), []byte("keep"), 0o600); err != nil {
					t.Fatal(err)
				}
				link, target := filepath.Join(root, "objects"), other
				if shape == "object" {
					if err := os.MkdirAll(link, 0o700); err != nil {
						t.Fatal(err)
					}
					link, target = filepath.Join(link, "data"), filepath.Join(other, "data")
				}
				if err := os.Symlink(target, link); err != nil {
					t.Skipf("symlinks unavailable: %v", err)
				}
				output := filepath.Join(t.TempDir(), "result")

				if err := runLocalStoreOperation(p, operation, source, "objects/data", output); err == nil {
					t.Fatal("expected the link inside the store to be refused")
				}
				got, err := os.ReadFile(filepath.Join(other, "data"))
				if err != nil || string(got) != "keep" {
					t.Fatalf("file outside the store changed: %q %v", got, err)
				}
				entries, err := os.ReadDir(other)
				if err != nil || len(entries) != 1 {
					t.Fatalf("directory outside the store changed: %v %v", entries, err)
				}
				if _, err := os.Stat(output); !os.IsNotExist(err) {
					t.Fatalf("download produced output through a link: %v", err)
				}
			})
		}
	}
}

// The configured store root must be the directory itself, not a link to one.
func TestLocalStoreRefusesLinkedRoot(t *testing.T) {
	for _, operation := range localStoreOperations {
		t.Run(operation, func(t *testing.T) {
			real := privateStoreTempDir(t)
			if err := os.MkdirAll(filepath.Join(real, "objects"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(real, "objects", "data"), []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(t.TempDir(), "store")
			if err := os.Symlink(real, root); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			source := filepath.Join(t.TempDir(), "source")
			if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(t.TempDir(), "result")

			if err := runLocalStoreOperation(NewLocalProvider(root), operation, source, "objects/data", output); err == nil {
				t.Fatal("expected a linked store root to be refused")
			}
			got, err := os.ReadFile(filepath.Join(real, "objects", "data"))
			if err != nil || string(got) != "keep" {
				t.Fatalf("linked directory changed: %q %v", got, err)
			}
		})
	}
}
