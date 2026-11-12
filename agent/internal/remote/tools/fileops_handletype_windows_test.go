//go:build windows

package tools

import (
	"os"
	"testing"
)

// Handles that are not files on disk (devices, pipes, consoles) are refused
// before anything is read or written.
func TestHandleCheckRefusesNonDiskHandles(t *testing.T) {
	for _, name := range []string{"NUL", "CONOUT$"} {
		f, err := os.OpenFile(name, os.O_RDWR, 0)
		if err != nil {
			t.Logf("%s: open: %v", name, err)
			continue
		}
		if err := requireDiskHandle(f); err == nil {
			t.Errorf("%s: a non-disk handle was accepted", name)
		}
		_ = f.Close()
	}
	f, err := os.CreateTemp(t.TempDir(), "x")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := requireDiskHandle(f); err != nil {
		t.Fatalf("a disk file was refused: %v", err)
	}
}
