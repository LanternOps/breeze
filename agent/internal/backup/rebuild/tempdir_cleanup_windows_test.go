//go:build windows

package rebuild

import (
	"os"
	"testing"
	"time"
)

// newMountTestRoot returns a test-owned temp root. Register it BEFORE
// attaching the VHDX so the (LIFO) cleanup runs after the detach.
func newMountTestRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "brz-mnt-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() {
		tolerated, fatal := removeAllTolerant(dir, 5, 200*time.Millisecond, os.RemoveAll)
		if tolerated != nil {
			t.Logf("leaving %s: %v (system-owned directory on a mounted volume)", dir, tolerated)
		}
		if fatal != nil {
			t.Errorf("cleanup %s: %v", dir, fatal)
		}
	})
	return dir
}
