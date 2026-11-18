//go:build windows

package securefs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// EnsurePrivateDirInRoot sets the private DACL on a directory that does not
// carry it, and leaves a directory that already does untouched, so repeated
// calls never re-propagate access entries through the directory's children.
func TestEnsurePrivateDirInRootAppliesDACLOnlyWhenNeeded(t *testing.T) {
	base := filepath.Join(t.TempDir(), "store")
	if err := EnsurePrivateDir(base); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	applied := 0
	old := applyPrivateDACLInRoot
	applyPrivateDACLInRoot = func(h windows.Handle) error { applied++; return old(h) }
	t.Cleanup(func() { applyPrivateDACLInRoot = old })

	// Created by the call: it already carries the private DACL.
	if err := EnsurePrivateDirInRoot(root, "created"); err != nil {
		t.Fatal(err)
	}
	if applied != 0 {
		t.Fatalf("DACL applied %d times to a directory created private", applied)
	}
	// Pre-existing with an inherited DACL: applied once, then left alone.
	if err := os.Mkdir(filepath.Join(base, "legacy"), 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := EnsurePrivateDirInRoot(root, "legacy"); err != nil {
			t.Fatal(err)
		}
	}
	if applied != 1 {
		t.Fatalf("DACL applied %d times to a legacy directory, want 1", applied)
	}
	if _, err := PrivateDirInfo(filepath.Join(base, "legacy")); err != nil {
		t.Fatalf("legacy directory not private after EnsurePrivateDirInRoot: %v", err)
	}
}

// An existing root whose DACL is inherited from a private parent (what older
// agents created under the protected data directory) is accepted: every entry
// names an allowed trustee with full control.
func TestPrivateDirInfoAcceptsInheritedPrivateDACL(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "data")
	if err := EnsurePrivateDir(parent); err != nil {
		t.Fatal(err)
	}
	store := filepath.Join(parent, "backups")
	if err := os.Mkdir(store, 0o700); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(store, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sd.String(), "ID;") {
		t.Fatalf("fixture DACL is not inherited: %s", sd.String())
	}
	if _, err := PrivateDirInfo(store); err != nil {
		t.Fatalf("inherited private DACL refused: %v", err)
	}
}

// An inherited entry for any other trustee is refused.
func TestPrivateDirInfoRefusesInheritedEntryForAnotherTrustee(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "data")
	if err := EnsurePrivateDir(parent); err != nil {
		t.Fatal(err)
	}
	sa, err := PrivateDirSecurityAttributes()
	if err != nil {
		t.Fatal(err)
	}
	broader, err := windows.SecurityDescriptorFromString(sa.SecurityDescriptor.String() + "(A;OICI;0x1200a9;;;BU)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := broader.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(parent, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	store := filepath.Join(parent, "backups")
	if err := os.Mkdir(store, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err = PrivateDirInfo(store)
	if err == nil || !strings.Contains(err.Error(), "another account") {
		t.Fatalf("expected the inherited entry for another trustee to be refused, got %v", err)
	}
}

// A volume root is never opened for modification: asking for more than
// READ_CONTROL on it is refused before any handle with that access exists.
func TestOpenVerifiedDirRefusesModifyingAVolumeRoot(t *testing.T) {
	volume := filepath.VolumeName(t.TempDir()) + `\`
	if chain, err := openVerifiedDir(volume, false, nil, windows.WRITE_DAC); err == nil {
		chain.close()
		t.Fatal("expected WRITE_DAC on a volume root to be refused")
	}
	chain, err := openVerifiedDir(volume, false, nil, windows.READ_CONTROL)
	if err != nil {
		t.Fatalf("READ_CONTROL on a volume root: %v", err)
	}
	chain.close()
}

// When the path is a volume root (the same branch a bare \\server\share
// takes) the root handle can read its owner and access list, so the
// directory is judged on them instead of failing to read them.
func TestPrivateDirInfoReadsVolumeRootSecurity(t *testing.T) {
	volume := filepath.VolumeName(t.TempDir()) + `\`
	_, err := PrivateDirInfo(volume)
	if err == nil {
		t.Skip("volume root is private on this host")
	}
	if strings.Contains(err.Error(), "read private directory owner") || strings.Contains(err.Error(), "read directory access list") {
		t.Fatalf("volume root security could not be read: %v", err)
	}
}
