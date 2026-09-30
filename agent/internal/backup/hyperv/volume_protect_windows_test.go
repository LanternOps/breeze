//go:build windows

package hyperv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestProtectVolumeRootRefusesInvalidDriveLetter(t *testing.T) {
	for _, letter := range []string{"", "EF", "1", `E:\`} {
		if _, err := protectVolumeRoot(letter); err == nil || !strings.Contains(err.Error(), "invalid drive letter") {
			t.Errorf("protectVolumeRoot(%q) = %v, want an invalid drive letter error", letter, err)
		}
	}
}

// The DACL half of protectVolumeRoot, exercised on a directory standing in
// for a volume root (the dismount step needs a real, dedicated volume and is
// covered by the Hyper-V lab run).
func TestVolumeRootDACLProtectVerifyRestore(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("needs an elevated token: the protected DACL grants only SYSTEM and Administrators")
	}
	root := t.TempDir() + `\`

	original, err := replaceRootDACL(root)
	if err != nil {
		t.Fatalf("replaceRootDACL: %v", err)
	}
	guard := &volumeRootGuard{root: root, original: original}
	restored := false
	t.Cleanup(func() {
		if !restored {
			_ = guard.restoreDefaults()
		}
	})

	if err := verifyProtectedVolumeRoot(root); err != nil {
		t.Fatalf("verify an empty protected root: %v", err)
	}

	if err := os.Mkdir(filepath.Join(root, "Windows"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := verifyProtectedVolumeRoot(root); err == nil || !strings.Contains(err.Error(), `"Windows"`) {
		t.Fatalf("verify a root holding an entry = %v, want it refused", err)
	}

	if err := guard.restoreDefaults(); err != nil {
		t.Fatalf("restoreDefaults: %v", err)
	}
	restored = true
	sd, err := windows.GetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if err := checkProtectedRootDACL(sd.String()); err == nil {
		t.Fatalf("after restoreDefaults the root still carries the protected DACL: %s", sd.String())
	}
}
