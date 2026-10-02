//go:build windows

package hyperv

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// fsctlDismountVolume is FSCTL_DISMOUNT_VOLUME (winioctl.h); x/sys/windows
// does not export it.
const fsctlDismountVolume = 0x00090020

// volumeRootGuard holds the new volume's DACL as formatting left it, so it
// can be put back once the restore has finished writing.
type volumeRootGuard struct {
	root     string // `E:\`
	original *windows.SECURITY_DESCRIPTOR
}

// protectVolumeRoot restricts a freshly formatted, mounted volume's root to
// SYSTEM and Administrators before anything is restored onto it:
//
//  1. read the root's DACL (kept for restoreDefaults) and replace it,
//     through the root's own handle, with protectedVolumeRootSDDL;
//  2. force a file-system dismount of the volume, which invalidates every
//     handle opened while the default DACL still let local users in (the
//     volume is mounted again on its next access);
//  3. read the DACL back and require it to be the protected one
//     (checkProtectedRootDACL), and require the root to hold nothing the
//     restore did not create (checkVolumeRootEntries).
//
// Any failure refuses the volume; the caller dismounts and discards it.
func protectVolumeRoot(driveLetter string) (*volumeRootGuard, error) {
	if err := checkDriveLetter(driveLetter); err != nil {
		return nil, err
	}
	root := driveLetter + `:\`

	original, err := replaceRootDACL(root)
	if err != nil {
		return nil, err
	}
	if err := forceDismountVolume(driveLetter); err != nil {
		return nil, err
	}
	if err := verifyProtectedVolumeRoot(root); err != nil {
		return nil, err
	}
	return &volumeRootGuard{root: root, original: original}, nil
}

func openVolumeRoot(root string, access uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return windows.InvalidHandle, err
	}
	return windows.CreateFile(p, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// replaceRootDACL returns the root's current DACL and puts the protected one
// in its place through the same handle.
func replaceRootDACL(root string) (*windows.SECURITY_DESCRIPTOR, error) {
	h, err := openVolumeRoot(root, windows.READ_CONTROL|windows.WRITE_DAC)
	if err != nil {
		return nil, fmt.Errorf("open volume root %s: %w", root, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()

	original, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return nil, fmt.Errorf("read volume root permissions: %w", err)
	}
	protected, err := windows.SecurityDescriptorFromString(protectedVolumeRootSDDL)
	if err != nil {
		return nil, fmt.Errorf("build volume root permissions: %w", err)
	}
	dacl, _, err := protected.DACL()
	if err != nil {
		return nil, fmt.Errorf("build volume root permissions: %w", err)
	}
	if err := windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		return nil, fmt.Errorf("restrict volume root permissions: %w", err)
	}
	return original, nil
}

// forceDismountVolume issues FSCTL_DISMOUNT_VOLUME without locking the
// volume first: the file system is dismounted even while other handles are
// open, and those handles stop working.
func forceDismountVolume(driveLetter string) error {
	p, err := windows.UTF16PtrFromString(`\\.\` + driveLetter + `:`)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return fmt.Errorf("open volume %s for dismount: %w", driveLetter, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var n uint32
	if err := windows.DeviceIoControl(h, fsctlDismountVolume, nil, 0, nil, 0, &n, nil); err != nil {
		return fmt.Errorf("dismount the file system on volume %s: %w", driveLetter, err)
	}
	return nil
}

// verifyProtectedVolumeRoot reads the root's DACL and entries back after the
// dismount.
func verifyProtectedVolumeRoot(root string) error {
	h, err := openVolumeRoot(root, windows.READ_CONTROL)
	if err != nil {
		return fmt.Errorf("open volume root %s: %w", root, err)
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	_ = windows.CloseHandle(h)
	if err != nil {
		return fmt.Errorf("read volume root permissions: %w", err)
	}
	if err := checkProtectedRootDACL(sd.String()); err != nil {
		return err
	}

	dirEntries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("list volume root %s: %w", root, err)
	}
	entries := make([]volumeRootEntry, 0, len(dirEntries))
	for _, d := range dirEntries {
		entries = append(entries, inspectRootEntry(filepath.Join(root, d.Name()), d.Name()))
	}
	return checkVolumeRootEntries(entries)
}

// inspectRootEntry reads an entry's attributes and owner from its own
// handle, opened without following a reparse point. What cannot be read is
// left empty, which checkVolumeRootEntries refuses.
func inspectRootEntry(path, name string) volumeRootEntry {
	e := volumeRootEntry{Name: name}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return e
	}
	h, err := windows.CreateFile(p, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return e
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return e
	}
	e.Dir = info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
	e.Reparse = info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return e
	}
	if owner, _, err := sd.Owner(); err == nil && owner != nil {
		e.OwnerSID = owner.String()
	}
	return e
}

// restoreDefaults puts the volume root's original DACL back once every
// restored file is in place. SetNamedSecurityInfo propagates the root's
// inheritable entries to everything beneath it, so the restored tree ends up
// with exactly the permissions it would have inherited from a default root.
func (g *volumeRootGuard) restoreDefaults() error {
	if g == nil || g.original == nil {
		return errors.New("no original volume root permissions to restore")
	}
	dacl, _, err := g.original.DACL()
	if err != nil {
		return fmt.Errorf("read original volume root permissions: %w", err)
	}
	control, _, err := g.original.Control()
	if err != nil {
		return fmt.Errorf("read original volume root permissions: %w", err)
	}
	info := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.UNPROTECTED_DACL_SECURITY_INFORMATION)
	if control&windows.SE_DACL_PROTECTED != 0 {
		info = windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION
	}
	if err := windows.SetNamedSecurityInfo(g.root, windows.SE_FILE_OBJECT, info, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("restore volume root permissions: %w", err)
	}
	return nil
}
