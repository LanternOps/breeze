//go:build linux || darwin

package providers

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// An entry inside the store that is neither a regular file nor a directory
// (here a named pipe) is refused, and refusing it never blocks on opening it.
func TestLocalStoreRefusesEntriesThatAreNotFilesOrDirectories(t *testing.T) {
	for _, operation := range localStoreOperations {
		t.Run(operation, func(t *testing.T) {
			root := privateStoreTempDir(t)
			if err := os.MkdirAll(filepath.Join(root, "objects"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := syscall.Mkfifo(filepath.Join(root, "objects", "data"), 0o600); err != nil {
				t.Skipf("named pipes unavailable: %v", err)
			}
			source := filepath.Join(t.TempDir(), "source")
			if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(t.TempDir(), "result")
			p := NewLocalProvider(root)
			done := make(chan error, 1)
			go func() { done <- runLocalStoreOperation(p, operation, source, "objects/data", output) }()
			var err error
			select {
			case err = <-done:
			case <-time.After(5 * time.Second):
				// Unblock the pending open so the goroutine can finish.
				if w, openErr := os.OpenFile(filepath.Join(root, "objects", "data"), os.O_WRONLY|syscall.O_NONBLOCK, 0); openErr == nil {
					_ = w.Close()
				}
				t.Fatal("operation blocked on an entry that is not a file or directory")
			}
			if err == nil || !strings.Contains(err.Error(), "not a regular file or directory") {
				t.Fatalf("expected the entry to be refused, got %v", err)
			}
			info, statErr := os.Lstat(filepath.Join(root, "objects", "data"))
			if statErr != nil || info.Mode()&os.ModeNamedPipe == 0 {
				t.Fatalf("entry changed: %v %v", info, statErr)
			}
		})
	}
}

// Download creates missing parents of its caller-chosen destination with the
// same mode other providers use; the restored file itself stays owner-only.
func TestLocalStoreDownloadDestinationParentsMatchOtherProviders(t *testing.T) {
	withUmask(t, 0o022)
	p := NewLocalProvider(privateStoreTempDir(t))
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := p.Upload(source, "objects/data"); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(t.TempDir(), "restore", "nested")
	output := filepath.Join(parent, "result")
	if err := p.Download("objects/data", output); err != nil {
		t.Fatal(err)
	}
	assertPerm(t, parent, 0o755)
	assertPerm(t, filepath.Dir(parent), 0o755)
	assertPerm(t, output, 0o600)
}
