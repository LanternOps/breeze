package logging

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRotatingWriterStaysClosed: once closed, the writer never opens its file
// again, not even through a rotation. A support session closes its log before
// removing its folder (#7629); a log line still in flight must not re-create
// the folder or the file.
func TestRotatingWriterStaysClosed(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "breeze-support-7629")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "support.log")
	rw, err := NewRotatingWriter(path, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := rw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	rw.maxSize = 1 // force the rotation path on the next write
	if _, err := rw.Write([]byte("a line after close\n")); err == nil {
		t.Error("Write after Close succeeded, want an error")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("Write after Close re-created %s (stat err %v)", dir, err)
	}
}
