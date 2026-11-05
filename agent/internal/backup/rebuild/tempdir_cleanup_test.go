package rebuild

import (
	"os"
	"strings"
	"testing"
	"time"
)

// A folder-mounted NTFS volume carries a system-owned "System Volume
// Information" directory that a non-SYSTEM runner token cannot delete, and
// that can linger briefly after the volume is unmounted. t.TempDir()'s
// cleanup fails the whole test on it (#11211), so tests that mount a volume
// own their temp root through newMountTestRoot instead.
const systemVolumeInfoDir = "System Volume Information"

// removeAllTolerant removes dir, retrying transient failures. A failure that
// persists and is about "System Volume Information" is returned as tolerated
// (the caller logs it); any other persistent failure is returned as fatal.
func removeAllTolerant(dir string, attempts int, delay time.Duration, removeAll func(string) error) (tolerated, fatal error) {
	var err error
	for i := 0; i < attempts; i++ {
		if err = removeAll(dir); err == nil {
			return nil, nil
		}
		if i < attempts-1 {
			time.Sleep(delay)
		}
	}
	if strings.Contains(err.Error(), systemVolumeInfoDir) {
		return err, nil
	}
	return nil, err
}

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

func TestRemoveAllTolerant(t *testing.T) {
	svi := &os.PathError{Op: "openfdat", Path: `x\mnt\root\System Volume Information`, Err: os.ErrPermission}

	t.Run("retries until it succeeds", func(t *testing.T) {
		calls := 0
		tol, fatal := removeAllTolerant("d", 5, 0, func(string) error {
			calls++
			if calls == 1 {
				return svi
			}
			return nil
		})
		if tol != nil || fatal != nil || calls != 2 {
			t.Fatalf("tolerated=%v fatal=%v calls=%d; want nil, nil, 2", tol, fatal, calls)
		}
	})
	t.Run("persistent System Volume Information is tolerated", func(t *testing.T) {
		calls := 0
		tol, fatal := removeAllTolerant("d", 3, 0, func(string) error { calls++; return svi })
		if tol == nil || fatal != nil || calls != 3 {
			t.Fatalf("tolerated=%v fatal=%v calls=%d; want tolerated, nil, 3", tol, fatal, calls)
		}
	})
	t.Run("other persistent errors are fatal", func(t *testing.T) {
		other := &os.PathError{Op: "unlink", Path: "d/file", Err: os.ErrPermission}
		tol, fatal := removeAllTolerant("d", 3, 0, func(string) error { return other })
		if tol != nil || fatal == nil {
			t.Fatalf("tolerated=%v fatal=%v; want nil, error", tol, fatal)
		}
	})
}
