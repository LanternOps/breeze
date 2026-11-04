//go:build !windows

package helper

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// A FIFO at a session-owned config path must be refused promptly rather than
// blocking the open (and the manager mutex held around it).
func TestHelperConfigReadersRefuseFIFO(t *testing.T) {
	readers := map[string]func(dir string) error{
		"readBranding": func(dir string) error {
			_, err := readBranding(filepath.Join(dir, "helper_config.yaml"))
			return err
		},
		"stripBranding": func(dir string) error {
			return stripBranding(filepath.Join(dir, "helper_config.yaml"))
		},
		"ReadStatus": func(dir string) error {
			_, err := ReadStatus(filepath.Join(dir, "helper_config.yaml"))
			return err
		},
	}
	for name, fn := range readers {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			for _, f := range []string{"helper_config.yaml", "helper_status.yaml"} {
				if err := syscall.Mkfifo(filepath.Join(dir, f), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			done := make(chan error, 1)
			go func() { done <- fn(dir) }()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("expected error for FIFO, got nil")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("read blocked on FIFO")
			}
		})
	}
}
