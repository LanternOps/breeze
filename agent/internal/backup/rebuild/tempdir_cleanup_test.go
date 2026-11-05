package rebuild

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
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
// persists and is a permission error on that exact directory is returned as tolerated
// (the caller logs it); any other persistent failure is returned as fatal.
func removeAllTolerant(dir string, attempts int, delay time.Duration, removeAll func(string) error) (tolerated, fatal error) {
	if attempts < 1 {
		attempts = 1
	}
	var err error
	for i := 0; i < attempts; i++ {
		if err = removeAll(dir); err == nil {
			return nil, nil
		}
		if i < attempts-1 {
			time.Sleep(delay)
		}
	}
	var pe *fs.PathError
	if errors.As(err, &pe) && strings.EqualFold(filepath.Base(strings.ReplaceAll(pe.Path, `\`, "/")), systemVolumeInfoDir) && errors.Is(pe.Err, fs.ErrPermission) {
		return err, nil
	}
	return nil, err
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

func TestRemoveAllTolerant_OnlyTheExactDirectory(t *testing.T) {
	// "System Volume Information" as a parent component, or a non-permission
	// cause, must stay fatal.
	for _, e := range []error{
		&os.PathError{Op: "unlink", Path: `x\System Volume Information\file`, Err: os.ErrPermission},
		&os.PathError{Op: "openfdat", Path: `x\System Volume Information`, Err: os.ErrInvalid},
	} {
		tol, fatal := removeAllTolerant("d", 2, 0, func(string) error { return e })
		if tol != nil || fatal == nil {
			t.Errorf("%v: tolerated=%v fatal=%v; want fatal", e, tol, fatal)
		}
	}
}
