//go:build linux || darwin

package tools

import (
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// A FIFO at an approved path must be refused promptly, not block the open
// waiting for a writer.
func TestDiagnosticFIFORefusedWithoutBlocking(t *testing.T) {
	skipIfNoGrantPlatform(t)
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	fifo := filepath.Join(root, "Logs", "pipe.log")
	if err := unix.Mkfifo(fifo, 0o600); err != nil {
		t.Skipf("mkfifo unavailable here: %v", err)
	}
	cmd := s.build(t, "read", fifo, rec(root), nil, nil, nil)
	done := make(chan string, 1)
	go func() { done <- diagCode(s.run(cmd, "read", env)) }()
	select {
	case got := <-done:
		if got == "OK" {
			t.Fatalf("FIFO served as a file")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("read of a FIFO blocked")
	}
}
