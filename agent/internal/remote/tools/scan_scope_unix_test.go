//go:build !windows

package tools

import (
	"path/filepath"
	"syscall"
	"testing"
)

// A scan root that is not a folder or a regular file (here a FIFO; device
// nodes alike) is refused without being opened.
func TestCheckRootRefusesFIFOWithoutOpeningIt(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	var opened []string
	testHookInspectOpen = func(p string) {
		if filepath.Base(p) == "pipe" {
			opened = append(opened, p)
		}
	}
	t.Cleanup(func() { testHookInspectOpen = nil })

	if _, err := NewScanScope().CheckRoot(fifo); err == nil {
		t.Fatal("a FIFO was accepted as a scan root")
	}
	if len(opened) != 0 {
		t.Fatalf("the FIFO was opened: %v", opened)
	}
}

// Resolving a path for the containment checks never opens a FIFO either.
func TestContainmentResolutionDoesNotOpenFIFO(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	var opened []string
	testHookInspectOpen = func(p string) {
		if filepath.Base(p) == "pipe" {
			opened = append(opened, p)
		}
	}
	t.Cleanup(func() { testHookInspectOpen = nil })

	_ = EnforcePathContainment("read", fifo)
	if len(opened) != 0 {
		t.Fatalf("the FIFO was opened: %v", opened)
	}
}
