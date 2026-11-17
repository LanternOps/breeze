//go:build linux || darwin

package providers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// withUmask pins the process umask so mode assertions do not depend on the
// shell that runs the tests.
func withUmask(t *testing.T, mask int) {
	t.Helper()
	old := syscall.Umask(mask)
	t.Cleanup(func() { syscall.Umask(old) })
}

func assertPerm(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %04o, want %04o", path, got, want)
	}
}

// A store the provider creates, its object directories and every object it
// writes are owner-only, regardless of a permissive umask and of the mode an
// object it replaces had.
func TestLocalStoreCreatesOwnerOnlyEntries(t *testing.T) {
	withUmask(t, 0o022)
	root := filepath.Join(t.TempDir(), "store")
	p := NewLocalProvider(root)
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"objects/plain/data", "objects/packed/data.gz"} {
		if err := p.Upload(source, key); err != nil {
			t.Fatalf("upload %s: %v", key, err)
		}
		object := filepath.Join(root, filepath.FromSlash(key))
		assertPerm(t, object, 0o600)
		if err := os.Chmod(object, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := p.UploadWithDigest(context.Background(), source, key); err != nil {
			t.Fatalf("digest upload %s: %v", key, err)
		}
		assertPerm(t, object, 0o600)
	}
	for _, dir := range []string{root, filepath.Join(root, "objects"), filepath.Join(root, "objects", "plain"), filepath.Join(root, "objects", "packed")} {
		assertPerm(t, dir, 0o700)
	}
}

// Download materializes restored content owner-only.
func TestLocalStoreDownloadOutputIsOwnerOnly(t *testing.T) {
	withUmask(t, 0o022)
	p := NewLocalProvider(privateStoreTempDir(t))
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"objects/data", "objects/data.gz"} {
		if err := p.Upload(source, key); err != nil {
			t.Fatal(err)
		}
		output := filepath.Join(t.TempDir(), "restore", "result")
		if err := p.Download(key, output); err != nil {
			t.Fatalf("download %s: %v", key, err)
		}
		assertPerm(t, output, 0o600)
		got, err := os.ReadFile(output)
		if err != nil || string(got) != "content" {
			t.Fatalf("download %s content: %q %v", key, got, err)
		}
	}
}

// An existing store root that grants group or other access is refused with
// operator guidance; the provider neither repairs its permissions nor touches
// its contents.
func TestLocalStoreRefusesBroadExistingRoot(t *testing.T) {
	for _, mode := range []os.FileMode{0o755, 0o750, 0o705, 0o711} {
		for _, operation := range localStoreOperations {
			t.Run(mode.String()+"/"+operation, func(t *testing.T) {
				root := filepath.Join(t.TempDir(), "store")
				if err := os.MkdirAll(filepath.Join(root, "objects"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "objects", "data"), []byte("old"), 0o644); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(root, mode); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(root, 0o700) })
				source := filepath.Join(t.TempDir(), "source")
				if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
					t.Fatal(err)
				}
				output := filepath.Join(t.TempDir(), "result")

				err := runLocalStoreOperation(NewLocalProvider(root), operation, source, "objects/data", output)
				if err == nil || !strings.Contains(err.Error(), "dedicated backup directory") {
					t.Fatalf("expected migration guidance, got %v", err)
				}
				assertPerm(t, root, mode)
				got, err := os.ReadFile(filepath.Join(root, "objects", "data"))
				if err != nil || string(got) != "old" {
					t.Fatalf("existing object changed: %q %v", got, err)
				}
				entries, err := os.ReadDir(filepath.Join(root, "objects"))
				if err != nil || len(entries) != 1 {
					t.Fatalf("store contents changed: %v %v", entries, err)
				}
				if _, err := os.Stat(output); !os.IsNotExist(err) {
					t.Fatalf("download produced output from a refused store: %v", err)
				}
			})
		}
	}
}

func TestLocalStorePrepareRefusesBroadExistingRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "store")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o700) })
	err := NewLocalProvider(root).Prepare()
	if err == nil || !strings.Contains(err.Error(), "dedicated backup directory") {
		t.Fatalf("expected migration guidance, got %v", err)
	}
	assertPerm(t, root, 0o755)
}

func TestLocalStorePrepareCreatesOwnerOnlyRoot(t *testing.T) {
	withUmask(t, 0o022)
	root := filepath.Join(t.TempDir(), "parent", "store")
	if err := NewLocalProvider(root).Prepare(); err != nil {
		t.Fatal(err)
	}
	assertPerm(t, root, 0o700)
}
