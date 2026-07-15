//go:build windows

package agentapp

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"golang.org/x/sys/windows"
)

func TestMainAgentGuardExclusiveAndReacquirable(t *testing.T) {
	dir := t.TempDir()
	restoreMainAgentGuardSeams(t)
	useMainAgentLockTestDir(t, dir)
	meta := ProcessStartup{PID: os.Getpid(), LaunchMode: "console-run", CreatedAt: time.Now()}

	first, err := acquireMainAgentGuard(meta)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireMainAgentGuard(meta); !errors.Is(err, ErrMainAgentAlreadyRunning) {
		t.Fatalf("second acquire err=%v, want ErrMainAgentAlreadyRunning", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("idempotent close: %v", err)
	}
	third, err := acquireMainAgentGuard(meta)
	if err != nil {
		t.Fatalf("reacquire after close: %v", err)
	}
	_ = third.Close()
}

func TestStaleLockFileDoesNotBlock(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, mainAgentLockFile), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	restoreMainAgentGuardSeams(t)
	useMainAgentLockTestDir(t, dir)
	guard, err := acquireMainAgentGuard(ProcessStartup{PID: os.Getpid(), LaunchMode: "console-run"})
	if err != nil {
		t.Fatal(err)
	}
	_ = guard.Close()
}

func TestMainAgentGuardRejectsReparseFinalObject(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, mainAgentLockFile), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	restoreMainAgentGuardSeams(t)
	useMainAgentLockTestDir(t, dir)
	getMainAgentLockInfoFn = func(_ windows.Handle, info *windows.ByHandleFileInformation) error {
		info.FileAttributes = windows.FILE_ATTRIBUTE_REPARSE_POINT
		return nil
	}

	_, err := acquireMainAgentGuard(ProcessStartup{PID: os.Getpid(), LaunchMode: "console-run"})
	if err == nil {
		t.Fatal("expected reparse-point security error")
	}
	if errors.Is(err, ErrMainAgentAlreadyRunning) {
		t.Fatalf("reparse security error misclassified as duplicate agent: %v", err)
	}
}

func TestMainAgentGuardOnlyMapsFinalLockContentionErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"sharing violation", windows.ERROR_SHARING_VIOLATION, true},
		{"lock violation", windows.ERROR_LOCK_VIOLATION, true},
		{"access denied", windows.ERROR_ACCESS_DENIED, false},
		{"invalid ACL", windows.ERROR_INVALID_ACL, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restoreMainAgentGuardSeams(t)
			prepareMainAgentLockDirFn = func() (string, error) { return t.TempDir(), nil }
			openPreparedMainAgentLockDirFn = func() (mainAgentLockDirectory, error) {
				return &testMainAgentLockDirectory{handle: windows.Handle(0x1234)}, nil
			}
			openMainAgentLockRelativeFn = func(windows.Handle, string) (windows.Handle, error) {
				return windows.InvalidHandle, tt.err
			}

			_, err := acquireMainAgentGuard(ProcessStartup{PID: os.Getpid()})
			if got := errors.Is(err, ErrMainAgentAlreadyRunning); got != tt.want {
				t.Fatalf("error = %v, duplicate classification=%v, want %v", err, got, tt.want)
			}
		})
	}
}

func TestMainAgentGuardDirectorySharingFailureIsSecurityError(t *testing.T) {
	restoreMainAgentGuardSeams(t)
	prepareMainAgentLockDirFn = func() (string, error) { return t.TempDir(), nil }
	openPreparedMainAgentLockDirFn = func() (mainAgentLockDirectory, error) {
		return nil, windows.ERROR_SHARING_VIOLATION
	}
	openMainAgentLockRelativeFn = func(windows.Handle, string) (windows.Handle, error) {
		t.Fatal("final lock open must not run after directory security failure")
		return windows.InvalidHandle, nil
	}

	_, err := acquireMainAgentGuard(ProcessStartup{PID: os.Getpid()})
	if err == nil {
		t.Fatal("expected fail-closed directory sharing error")
	}
	if errors.Is(err, ErrMainAgentAlreadyRunning) {
		t.Fatalf("directory sharing failure misclassified as duplicate agent: %v", err)
	}
}

func TestMainAgentGuardPrepareFailureIsSecurityError(t *testing.T) {
	restoreMainAgentGuardSeams(t)
	wantErr := errors.New("injected directory security failure")
	prepareMainAgentLockDirFn = func() (string, error) { return "", wantErr }

	_, err := acquireMainAgentGuard(ProcessStartup{PID: os.Getpid()})
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want wrapped preparation error", err)
	}
	if errors.Is(err, ErrMainAgentAlreadyRunning) {
		t.Fatalf("directory security error misclassified as duplicate agent: %v", err)
	}
}

func TestOpenMainAgentLockUsesVerifiedRunHandle(t *testing.T) {
	restoreMainAgentGuardSeams(t)
	wantDirHandle := windows.Handle(0x1234)
	wantLockHandle := windows.Handle(0x5678)
	dir := &testMainAgentLockDirectory{handle: wantDirHandle}
	openPreparedMainAgentLockDirFn = func() (mainAgentLockDirectory, error) {
		return dir, nil
	}
	openMainAgentLockRelativeFn = func(dir windows.Handle, name string) (windows.Handle, error) {
		if dir != wantDirHandle {
			t.Fatalf("relative root = %#x, want verified run handle %#x", dir, wantDirHandle)
		}
		if name != mainAgentLockFile {
			t.Fatalf("relative lock name = %q, want %q", name, mainAgentLockFile)
		}
		return wantLockHandle, nil
	}

	got, err := openMainAgentLock(filepath.Join(`C:\ProgramData\Breeze\run`, mainAgentLockFile))
	if err != nil {
		t.Fatal(err)
	}
	if got.handle != wantLockHandle {
		t.Fatalf("lock handle = %#x, want %#x", got.handle, wantLockHandle)
	}
	if got.directory != dir {
		t.Fatal("verified namespace owner was not retained with the lock handle")
	}
	if dir.closed {
		t.Fatal("verified namespace was closed before guard ownership")
	}
}

func restoreMainAgentGuardSeams(t *testing.T) {
	t.Helper()
	oldPrepare := prepareMainAgentLockDirFn
	oldOpen := openMainAgentLockFn
	oldInfo := getMainAgentLockInfoFn
	oldHarden := hardenAndVerifyLockHandleFn
	oldOpenPreparedDir := openPreparedMainAgentLockDirFn
	oldOpenRelative := openMainAgentLockRelativeFn
	t.Cleanup(func() {
		prepareMainAgentLockDirFn = oldPrepare
		openMainAgentLockFn = oldOpen
		getMainAgentLockInfoFn = oldInfo
		hardenAndVerifyLockHandleFn = oldHarden
		openPreparedMainAgentLockDirFn = oldOpenPreparedDir
		openMainAgentLockRelativeFn = oldOpenRelative
	})
	prepareMainAgentLockDirFn = config.PrepareMainAgentLockDir
}

func useMainAgentLockTestDir(t *testing.T, dir string) {
	t.Helper()
	prepareMainAgentLockDirFn = func() (string, error) { return dir, nil }
	openPreparedMainAgentLockDirFn = func() (mainAgentLockDirectory, error) {
		path16, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return nil, err
		}
		h, err := windows.CreateFile(
			path16,
			windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			nil,
			windows.OPEN_EXISTING,
			windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS,
			0,
		)
		if err != nil {
			return nil, err
		}
		return &testMainAgentLockDirectory{
			handle: h,
			closeFn: func() error {
				return windows.CloseHandle(h)
			},
		}, nil
	}
}

type testMainAgentLockDirectory struct {
	handle  windows.Handle
	closed  bool
	closeFn func() error
}

func (d *testMainAgentLockDirectory) Handle() windows.Handle { return d.handle }

func (d *testMainAgentLockDirectory) Close() error {
	if d.closed {
		return nil
	}
	d.closed = true
	if d.closeFn != nil {
		return d.closeFn()
	}
	return nil
}
