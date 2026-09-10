//go:build windows

package securefs

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows has no openat(2), so a path cannot be pinned component by component
// through descriptors the way the unix implementation does. The equivalent
// Win32 boundary is:
//
//   - every component of the walked path is opened with
//     FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS and rejected
//     when it carries FILE_ATTRIBUTE_REPARSE_POINT. Redirection on NTFS can
//     only happen through a reparse point (symlink, junction, mount point) —
//     there are no directory hard links — so a walk that refuses every
//     reparse point cannot be redirected out of the intended tree;
//   - the resulting directory handle is then re-checked against the requested
//     path with GetFinalPathNameByHandle. A component swapped underneath the
//     walk shows up as a different final path, so the race fails closed
//     instead of silently resolving somewhere else;
//   - files are published with MoveFileEx(MOVEFILE_REPLACE_EXISTING |
//     MOVEFILE_WRITE_THROUGH), which replaces the destination NAME atomically.
//     The destination is never removed first, so there is no window in which
//     the caller's data is gone, and a destination that is itself a symlink is
//     replaced rather than written through.
const (
	openDirFlags     = windows.FILE_FLAG_BACKUP_SEMANTICS | windows.FILE_FLAG_OPEN_REPARSE_POINT
	openFileNoFollow = windows.FILE_FLAG_OPEN_REPARSE_POINT
	shareAll         = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE

	// privateDirSDDLPrefix restricts a staging directory to SYSTEM and the
	// local Administrators group. "PAI" makes the DACL protected: inheritance
	// from the parent (typically C:\Windows\Temp or %TEMP%, which grant rights
	// far more broadly) is disabled, so no inherited ACE can widen access.
	privateDirSDDLPrefix = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
)

// fileBasicInfo mirrors FILE_BASIC_INFO. Layout on every Windows ABI is four
// LARGE_INTEGERs followed by a DWORD, padded to an 8-byte multiple, which is
// exactly what Go lays out for this struct.
type fileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
	_              uint32
}

// PrivateDirSecurityAttributes builds SECURITY_ATTRIBUTES carrying an explicit,
// protected DACL granting full control to SYSTEM, the local Administrators
// group and — when the agent runs as neither — the account the agent process
// actually runs under. Exported so the executor can create its per-script
// staging directory with the same descriptor.
func PrivateDirSecurityAttributes() (*windows.SecurityAttributes, error) {
	sddl := privateDirSDDLPrefix
	if own, err := ownAccountSID(); err == nil && own != "" && own != "S-1-5-18" {
		sddl += "(A;OICI;FA;;;" + own + ")"
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, fmt.Errorf("build private directory security descriptor: %w", err)
	}
	sa := &windows.SecurityAttributes{
		SecurityDescriptor: sd,
		InheritHandle:      0,
	}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	return sa, nil
}

func ownAccountSID() (string, error) {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

// VerifyPrivateDirHandle confirms, from the handle alone, that dir is a real
// directory (not a reparse point), is owned by SYSTEM, Administrators or the
// agent's own account, and carries a protected DACL so nothing is inherited.
// Exported for the executor's script staging directory.
func VerifyPrivateDirHandle(handle windows.Handle) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return fmt.Errorf("inspect private directory: %w", err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return errors.New("private staging path is not a directory")
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("private staging path is a reparse point")
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read private directory security descriptor: %w", err)
	}
	control, _, err := sd.Control()
	if err != nil {
		return fmt.Errorf("read private directory control flags: %w", err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("private staging directory DACL is not protected against inheritance")
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("read private directory owner: %w", err)
	}
	if owner == nil {
		return errors.New("private staging directory has no owner")
	}
	if owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return nil
	}
	if own, err := ownAccountSID(); err == nil && own == owner.String() {
		return nil
	}
	return fmt.Errorf("private staging directory is owned by %s", owner.String())
}

// VerifyPrivateDir opens path without following a reparse point and applies
// VerifyPrivateDirHandle to the resulting handle. Callers use it right after an
// exclusive CreateDirectory to confirm the directory they just created really
// is a locked-down directory before anything privileged is written into it.
func VerifyPrivateDir(path string) error {
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(wide,
		windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL, shareAll, nil,
		windows.OPEN_EXISTING, openDirFlags, 0)
	if err != nil {
		return fmt.Errorf("open private staging directory: %w", err)
	}
	defer windows.CloseHandle(handle)
	return VerifyPrivateDirHandle(handle)
}

func splitWindowsComponents(rest string) []string {
	var out []string
	for _, component := range strings.Split(rest, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		out = append(out, component)
	}
	return out
}

// openVerifiedDir walks path one component at a time. finalSA, when non-nil, is
// applied only to the LAST component if this call creates it: intermediate
// parents keep their inherited descriptor so an agent-data tree stays usable,
// while the staging directory itself is locked down.
func openVerifiedDir(path string, create bool, finalSA *windows.SecurityAttributes) (windows.Handle, error) {
	if !filepath.IsAbs(path) {
		return windows.InvalidHandle, fmt.Errorf("directory must be absolute: %q", path)
	}
	path = filepath.Clean(path)
	volume := filepath.VolumeName(path)
	if volume == "" {
		return windows.InvalidHandle, fmt.Errorf("directory must name a volume: %q", path)
	}
	current := volume + string(filepath.Separator)
	handle, err := openDirComponent(current, false, nil)
	if err != nil {
		return windows.InvalidHandle, err
	}
	components := splitWindowsComponents(strings.Trim(path[len(volume):], `\/`))
	for i, component := range components {
		current = filepath.Join(current, component)
		var sa *windows.SecurityAttributes
		if i == len(components)-1 {
			sa = finalSA
		}
		next, err := openDirComponent(current, create, sa)
		windows.CloseHandle(handle)
		if err != nil {
			return windows.InvalidHandle, err
		}
		handle = next
	}
	if err := verifyHandleStillAtPath(handle, path); err != nil {
		windows.CloseHandle(handle)
		return windows.InvalidHandle, err
	}
	return handle, nil
}

func openDirComponent(path string, create bool, sa *windows.SecurityAttributes) (windows.Handle, error) {
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	if create {
		if err := windows.CreateDirectory(wide, sa); err != nil && err != windows.ERROR_ALREADY_EXISTS {
			return windows.InvalidHandle, fmt.Errorf("create %q: %w", path, err)
		}
	}
	handle, err := windows.CreateFile(wide,
		windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.FILE_LIST_DIRECTORY,
		shareAll, nil, windows.OPEN_EXISTING, openDirFlags, 0)
	if err != nil {
		return windows.InvalidHandle, fmt.Errorf("open %q: %w", path, err)
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		windows.CloseHandle(handle)
		return windows.InvalidHandle, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(handle)
		return windows.InvalidHandle, fmt.Errorf("path component is a reparse point: %q", path)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		windows.CloseHandle(handle)
		return windows.InvalidHandle, fmt.Errorf("path component is not a directory: %q", path)
	}
	return handle, nil
}

// verifyHandleStillAtPath fails closed when the directory the walk pinned is no
// longer the directory the requested path names — the Win32 answer to a
// component renamed, or replaced by a junction, between two of the walk's
// opens.
//
// The check compares OBJECT IDENTITY (volume serial + file index), not path
// strings: %TEMP% and other real-world paths are frequently handed to a process
// in 8.3 short form, so a textual comparison against GetFinalPathNameByHandle
// would reject perfectly legitimate paths. The re-open deliberately does NOT
// pass FILE_FLAG_OPEN_REPARSE_POINT for intermediate components, so if a
// component was swapped for a junction the re-open lands somewhere else and the
// identities differ. (File indices are unique per volume on NTFS; on ReFS they
// are 128-bit and the low 64 bits are still what Win32 reports here.)
func verifyHandleStillAtPath(handle windows.Handle, path string) error {
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	recheck, err := windows.CreateFile(wide, windows.FILE_READ_ATTRIBUTES, shareAll, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return fmt.Errorf("re-open pinned directory: %w", err)
	}
	defer windows.CloseHandle(recheck)
	same, err := sameObject(handle, recheck)
	if err != nil {
		return err
	}
	if !same {
		return fmt.Errorf("pinned directory %q was replaced during the walk", path)
	}
	return nil
}

func sameObject(a, b windows.Handle) (bool, error) {
	var infoA, infoB windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(a, &infoA); err != nil {
		return false, err
	}
	if err := windows.GetFileInformationByHandle(b, &infoB); err != nil {
		return false, err
	}
	return infoA.VolumeSerialNumber == infoB.VolumeSerialNumber &&
		infoA.FileIndexHigh == infoB.FileIndexHigh &&
		infoA.FileIndexLow == infoB.FileIndexLow, nil
}

func ensureDir(path string, mode os.FileMode, private bool) error {
	var sa *windows.SecurityAttributes
	if private {
		built, err := PrivateDirSecurityAttributes()
		if err != nil {
			return err
		}
		sa = built
	}
	handle, err := openVerifiedDir(path, true, sa)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	if private {
		return VerifyPrivateDirHandle(handle)
	}
	return nil
}

func installFile(base, relative, source string, mode os.FileMode, modTime time.Time) ([]error, error) {
	parent := base
	if dir := filepath.Dir(relative); dir != "." {
		parent = filepath.Join(base, dir)
	}
	handle, err := openVerifiedDir(parent, true, nil)
	if err != nil {
		return nil, fmt.Errorf("open target parent: %w", err)
	}
	defer windows.CloseHandle(handle)

	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, fmt.Errorf("generate temporary name: %w", err)
	}
	tempPath := filepath.Join(parent, ".breeze-restore-"+hex.EncodeToString(random[:]))
	tempWide, err := windows.UTF16PtrFromString(tempPath)
	if err != nil {
		return nil, err
	}
	// CREATE_NEW is the exclusive create: a squatted name fails instead of
	// being reused, and OPEN_REPARSE_POINT means a planted link is never
	// written through.
	tempHandle, err := windows.CreateFile(tempWide,
		windows.GENERIC_WRITE|windows.FILE_WRITE_ATTRIBUTES, 0, nil,
		windows.CREATE_NEW, openFileNoFollow, 0)
	if err != nil {
		return nil, fmt.Errorf("create target temporary file: %w", err)
	}
	temp := os.NewFile(uintptr(tempHandle), tempPath)
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()

	src, err := os.Open(source)
	if err != nil {
		return nil, fmt.Errorf("open staging file: %w", err)
	}
	_, copyErr := io.Copy(temp, src)
	closeErr := src.Close()
	if copyErr != nil {
		return nil, fmt.Errorf("copy staging file: %w", copyErr)
	}
	if closeErr != nil {
		return nil, closeErr
	}

	var warnings []error
	basic := fileBasicInfo{FileAttributes: windows.FILE_ATTRIBUTE_NORMAL}
	if mode != 0 && mode.Perm()&0o200 == 0 {
		basic.FileAttributes = windows.FILE_ATTRIBUTE_READONLY
	}
	if !modTime.IsZero() {
		ft := windows.NsecToFiletime(modTime.UnixNano())
		stamp := int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime)
		basic.LastWriteTime = stamp
		basic.ChangeTime = stamp
	}
	if err := setBasicInfo(tempHandle, &basic); err != nil {
		warnings = append(warnings, fmt.Errorf("apply file attributes: %w", err))
	}
	if err := temp.Sync(); err != nil {
		return nil, fmt.Errorf("sync target temporary file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return nil, fmt.Errorf("close target temporary file: %w", err)
	}

	destination := filepath.Join(parent, filepath.Base(relative))
	if err := replaceAtomically(tempPath, destination); err != nil {
		return nil, err
	}
	committed = true
	if err := os.Remove(source); err != nil && !os.IsNotExist(err) {
		warnings = append(warnings, fmt.Errorf("remove staging file: %w", err))
	}
	return warnings, nil
}

func setBasicInfo(handle windows.Handle, info *fileBasicInfo) error {
	return windows.SetFileInformationByHandle(handle, windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(info)), uint32(unsafe.Sizeof(*info)))
}

// replaceAtomically publishes temp over destination without ever unlinking
// destination first. MOVEFILE_REPLACE_EXISTING makes the name swap atomic and
// MOVEFILE_WRITE_THROUGH does not return until the change is on disk, so an
// interruption leaves either the old file or the new one — never neither.
//
// A destination carrying FILE_ATTRIBUTE_READONLY (very common for restored app
// config, D19) makes the rename fail with ERROR_ACCESS_DENIED. The attribute is
// then cleared through a handle opened with OPEN_REPARSE_POINT — so a planted
// link is not followed — and the rename retried exactly once.
func replaceAtomically(temp, destination string) error {
	from, err := windows.UTF16PtrFromString(temp)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	const flags = windows.MOVEFILE_REPLACE_EXISTING | windows.MOVEFILE_WRITE_THROUGH
	err = windows.MoveFileEx(from, to, flags)
	if err == nil {
		return nil
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return fmt.Errorf("publish target file: %w", err)
	}
	if clearErr := clearReadOnlyAttribute(destination); clearErr != nil {
		return fmt.Errorf("publish target file: %w", err)
	}
	if err := windows.MoveFileEx(from, to, flags); err != nil {
		return fmt.Errorf("publish target file: %w", err)
	}
	return nil
}

func clearReadOnlyAttribute(path string) error {
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(wide,
		windows.FILE_READ_ATTRIBUTES|windows.FILE_WRITE_ATTRIBUTES, shareAll, nil,
		windows.OPEN_EXISTING, openFileNoFollow, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("destination is a reparse point")
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_READONLY == 0 {
		return errors.New("destination is not read-only")
	}
	attrs := info.FileAttributes &^ windows.FILE_ATTRIBUTE_READONLY
	if attrs == 0 {
		attrs = windows.FILE_ATTRIBUTE_NORMAL
	}
	basic := fileBasicInfo{FileAttributes: attrs}
	return setBasicInfo(handle, &basic)
}

func statFile(base, relative string) (os.FileInfo, error) {
	parent := base
	if dir := filepath.Dir(relative); dir != "." {
		parent = filepath.Join(base, dir)
	}
	handle, err := openVerifiedDir(parent, false, nil)
	if err != nil {
		return nil, err
	}
	windows.CloseHandle(handle)

	path := filepath.Join(parent, filepath.Base(relative))
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	fileHandle, err := windows.CreateFile(wide, windows.FILE_READ_ATTRIBUTES, shareAll, nil,
		windows.OPEN_EXISTING, openFileNoFollow, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fileHandle), path)
	defer f.Close()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(fileHandle, &info); err != nil {
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return nil, fmt.Errorf("target is a link: %q", path)
	}
	return f.Stat()
}
