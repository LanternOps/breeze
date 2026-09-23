//go:build windows

package securefs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func fileIDOfHandle(t *testing.T, h windows.Handle) [3]uint32 {
	t.Helper()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		t.Fatalf("GetFileInformationByHandle: %v", err)
	}
	return [3]uint32{info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow}
}

func fileIDOfPath(t *testing.T, p string) [3]uint32 {
	t.Helper()
	wide, err := windows.UTF16PtrFromString(p)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(wide, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatalf("open %s: %v", p, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	return fileIDOfHandle(t, h)
}

// protectedDACLForTest returns a protected DACL that no freshly created file
// in %TEMP% carries, so its presence on the published file proves the
// applier's write through the pinned handle landed.
func protectedDACLForTest(t *testing.T) *windows.ACL {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString("D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;OW)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	return dacl
}

// TestInstallFileWithSecurityAppliesToPinnedTemporaryBeforePublish (Windows):
// the applier runs on the pinned temporary's handle — opened WITH the
// requested Access (WRITE_DAC here) — while the destination name does not
// exist yet; that handle's file IS the one published, and the DACL written
// through it is on the published file.
func TestInstallFileWithSecurityAppliesToPinnedTemporaryBeforePublish(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "nested", "file.txt")
	dacl := protectedDACLForTest(t)
	var appliedID [3]uint32
	calls := 0
	sec := &SecurityApplier{Access: windows.WRITE_DAC, Apply: func(h uintptr) error {
		calls++
		appliedID = fileIDOfHandle(t, windows.Handle(h))
		if _, err := os.Lstat(dest); !os.IsNotExist(err) {
			t.Errorf("destination already published when the applier ran (lstat err %v)", err)
		}
		return windows.SetSecurityInfo(windows.Handle(h), windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
	}}
	warnings, err := InstallFileWithSecurity(base, filepath.Join("nested", "file.txt"), writeSource(t, "data"), 0o644, time.Time{}, nil, 0, sec)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("InstallFileWithSecurity = %v, %v", warnings, err)
	}
	if calls != 1 {
		t.Fatalf("applier ran %d times, want 1", calls)
	}
	if got := fileIDOfPath(t, dest); got != appliedID {
		t.Errorf("published file id %v != id of the handle the applier was given %v", got, appliedID)
	}
	sd, err := windows.GetNamedSecurityInfo(dest, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if s := sd.String(); !strings.Contains(s, "D:P") {
		t.Errorf("published DACL %q is not the protected DACL written through the pinned handle", s)
	}
}

// TestInstallFileWithSecurityApplyErrorIsAWarning (Windows).
func TestInstallFileWithSecurityApplyErrorIsAWarning(t *testing.T) {
	base := t.TempDir()
	sec := &SecurityApplier{Apply: func(uintptr) error { return errors.New("boom") }}
	warnings, err := InstallFileWithSecurity(base, "f.txt", writeSource(t, "data"), 0o644, time.Time{}, nil, 0, sec)
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0].Error(), "apply security descriptor: boom") {
		t.Fatalf("warnings = %v, want one 'apply security descriptor: boom'", warnings)
	}
	if b, err := os.ReadFile(filepath.Join(base, "f.txt")); err != nil || string(b) != "data" {
		t.Fatalf("file not published: %q, %v", b, err)
	}
}

// TestApplyDirSecurityRefusesJunction (Windows): positive control (the
// applier gets the directory's own handle, with the requested Access), a
// junction at an intermediate component is refused before the applier runs,
// and a missing directory is not created.
func TestApplyDirSecurityRefusesJunction(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real", "sub")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	dacl := protectedDACLForTest(t)
	var got [3]uint32
	if err := ApplyDirSecurity(base, filepath.Join("real", "sub"), SecurityApplier{Access: windows.WRITE_DAC, Apply: func(h uintptr) error {
		got = fileIDOfHandle(t, windows.Handle(h))
		return windows.SetSecurityInfo(windows.Handle(h), windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
	}}); err != nil {
		t.Fatalf("positive control: %v", err)
	}
	if want := fileIDOfPath(t, real); got != want {
		t.Errorf("applier handed file id %v, want the directory's %v", got, want)
	}

	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	mkJunction(t, filepath.Join(base, "link"), outside)
	called := false
	err := ApplyDirSecurity(base, filepath.Join("link", "sub"), SecurityApplier{Apply: func(uintptr) error { called = true; return nil }})
	if err == nil || called {
		t.Fatalf("junction component: err=%v called=%v, want refusal before apply", err, called)
	}

	err = ApplyDirSecurity(base, "missing", SecurityApplier{Apply: func(uintptr) error { called = true; return nil }})
	if err == nil || called {
		t.Fatalf("missing dir: err=%v called=%v, want an error and no apply", err, called)
	}
	if _, statErr := os.Stat(filepath.Join(base, "missing")); !os.IsNotExist(statErr) {
		t.Error("ApplyDirSecurity created a missing directory")
	}
}
