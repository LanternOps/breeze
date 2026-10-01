//go:build windows

package bmr

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func daclSDDL(t *testing.T, h windows.Handle) (string, windows.SECURITY_DESCRIPTOR_CONTROL) {
	t.Helper()
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetSecurityInfo: %v", err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatalf("Control: %v", err)
	}
	return sd.String(), control
}

func TestCreateStagingFile_ProtectedPrivateDACL(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".breeze-staging-test")
	f, err := createStagingFile(path)
	if err != nil {
		t.Fatalf("createStagingFile: %v", err)
	}
	defer func() { _ = f.Close() }()

	_, control := daclSDDL(t, windows.Handle(f.Fd()))
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatal("staging DACL is not protected against inheritance")
	}
	sd, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		t.Fatalf("staging DACL: %v", err)
	}
	own, _ := processAccountSID()
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsWellKnown(windows.WinLocalSystemSid) && !sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) && sid.String() != own {
			t.Fatalf("staging DACL grants %s", sid.String())
		}
	}

	// A second exclusive create of the same name fails.
	if _, err := createStagingFile(path); err == nil {
		t.Fatal("second createStagingFile of the same path succeeded")
	}
}

func TestAttestedRestore_ReplacedTargetKeepsDACL(t *testing.T) {
	fx := newRecoveryFixture(t, "snap-stage-dacl", []fixtureFile{
		{source: "/d/keep.conf", content: []byte("restored bytes")},
	})
	target := fx.targets["/d/keep.conf"]
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("older bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	own, err := processAccountSID()
	if err != nil {
		t.Fatal(err)
	}
	custom, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;WD)(A;;FA;;;" + own + ")")
	if err != nil {
		t.Fatal(err)
	}
	customDACL, _, err := custom.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(target, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, customDACL, nil); err != nil {
		t.Fatal(err)
	}
	before, err := windows.GetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	e := attestedExpectation(t, fx.snapshotID, fx.manifestBytes)

	res, err := RunRecoveryContext(context.Background(), fx.config(e), fx.provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if res.FilesRestored != 1 || res.FailedFiles != 0 {
		t.Fatalf("filesRestored=%d failedFiles=%d warnings=%v, want 1/0", res.FilesRestored, res.FailedFiles, res.Warnings)
	}
	if got, _ := os.ReadFile(target); string(got) != "restored bytes" {
		t.Fatalf("target = %q", got)
	}
	after, err := windows.GetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if after.String() != before.String() {
		t.Fatalf("DACL after restore = %s, want the existing target's %s", after.String(), before.String())
	}
	assertNoStagingLeftovers(t, fx.targetRoot)
}
