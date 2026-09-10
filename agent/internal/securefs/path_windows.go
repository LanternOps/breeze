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
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows has no openat(2) in the Win32 surface, but NtCreateFile does: an
// OBJECT_ATTRIBUTES with RootDirectory set to an already-open directory handle
// resolves ObjectName RELATIVE to that handle, with no re-resolution from the
// volume root. That makes the same boundary the unix implementation gets from
// openat/O_NOFOLLOW available here:
//
//   - the walk opens one component at a time, each relative to the previous
//     component's handle, with FILE_OPEN_REPARSE_POINT, and rejects anything
//     carrying FILE_ATTRIBUTE_REPARSE_POINT. NTFS redirection can only happen
//     through a reparse point (symlink, junction, mount point) and there are no
//     directory hard links, so a walk that refuses every reparse point cannot be
//     redirected out of the intended tree;
//   - EVERY component handle stays open until the operation completes, and none
//     of them is shared for delete (no FILE_SHARE_DELETE). A pinned component
//     therefore cannot be renamed or removed out from under the operation, so
//     the rmdir+"mklink /J" race fails closed instead of being won;
//   - the temporary file is created relative to the pinned parent handle
//     (FILE_CREATE — the exclusive create) and published with
//     SetFileInformationByHandle(FileRenameInfo) whose RootDirectory is that
//     same pinned parent handle and whose ReplaceIfExists is TRUE. No path
//     string reaches the kernel after the walk, and the destination is NEVER
//     removed first, so there is no window in which the caller's data is gone.
//     A destination that is itself a link is replaced by NAME rather than
//     written through, exactly like renameat on unix.
//
// Only the volume root ("C:\") is opened by path, which cannot be a reparse
// point.
const (
	// Directory and file handles held across an operation are deliberately NOT
	// shared for delete: that is what pins the component.
	shareNoDelete = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE

	// FILE handles (the temporary, and a destination being inspected) DO share
	// delete. Only directories are pinned against rename/delete; a data file
	// must remain replaceable, exactly as it is on unix, or two restores
	// publishing to the same destination deadlock each other: the winner keeps
	// its handle open until installFile returns, and a sibling's rename onto
	// that name then fails with a sharing violation. This does not widen the
	// boundary — the temporary's name is random and the file itself is pinned
	// by handle.
	shareFile = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE

	// FileRenameInformationEx, the NT information class that takes flags rather
	// than a bare BOOLEAN. x/sys/windows does not export it. Windows 10 RS1 /
	// Server 2016 and later; older kernels answer STATUS_INVALID_INFO_CLASS and
	// we fall back to class 10.
	fileRenameInformationEx = 65

	ntDirOptions  = windows.FILE_DIRECTORY_FILE | windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT
	ntFileOptions = windows.FILE_NON_DIRECTORY_FILE | windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT

	// privateDirSDDLPrefix restricts a staging directory to SYSTEM and the
	// local Administrators group. "PAI" makes the DACL protected: inheritance
	// from the parent (typically C:\Windows\Temp or %TEMP%, which grant rights
	// far more broadly) is disabled, so no inherited ACE can widen access.
	privateDirSDDLPrefix = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
)

// fileBasicInfo mirrors FILE_BASIC_INFO: four LARGE_INTEGERs then a DWORD,
// padded to an 8-byte multiple, which is exactly what Go lays out here. A zero
// timestamp means "leave unchanged".
type fileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
	_              uint32
}

// dirChain is a pinned path: one open handle per component, volume root first,
// target directory last. Every handle stays open for the life of the chain, so
// no component can be renamed or deleted while the operation runs.
type dirChain struct {
	handles []windows.Handle
}

func (c *dirChain) leaf() windows.Handle { return c.handles[len(c.handles)-1] }

func (c *dirChain) close() {
	for i := len(c.handles) - 1; i >= 0; i-- {
		_ = windows.CloseHandle(c.handles[i])
	}
	c.handles = nil
}

// openRelativeComponent is the openat equivalent: name is resolved relative to
// parent, never from the volume root.
func openRelativeComponent(parent windows.Handle, name string, access uint32, share uint32, disposition uint32, options uint32, sa *windows.SecurityAttributes) (windows.Handle, error) {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return windows.InvalidHandle, err
	}
	oa := &windows.OBJECT_ATTRIBUTES{
		RootDirectory: parent,
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE,
	}
	if sa != nil {
		oa.SecurityDescriptor = sa.SecurityDescriptor
	}
	oa.Length = uint32(unsafe.Sizeof(*oa))
	var handle windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	if err := windows.NtCreateFile(&handle, access|windows.SYNCHRONIZE, oa, &iosb, nil,
		windows.FILE_ATTRIBUTE_NORMAL, share, disposition, options, 0, 0); err != nil {
		return windows.InvalidHandle, err
	}
	return handle, nil
}

func rejectReparseOrNonDir(handle windows.Handle, name string) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("refusing to write through path component %q: it is a reparse point (a symlink, junction or mount point)", name)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return fmt.Errorf("path component is not a directory: %q", name)
	}
	return nil
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

// openVerifiedDir walks path one component at a time, each relative to the
// previous component's handle, and returns the whole pinned chain. finalSA,
// when non-nil, is applied only to the LAST component if this call creates it:
// intermediate parents keep their inherited descriptor so an agent-data tree
// stays usable, while the staging directory itself is locked down.
func openVerifiedDir(path string, create bool, finalSA *windows.SecurityAttributes, finalAccess uint32) (*dirChain, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("directory must be absolute: %q", path)
	}
	path = filepath.Clean(path)
	volume := filepath.VolumeName(path)
	if volume == "" {
		return nil, fmt.Errorf("directory must name a volume: %q", path)
	}
	// The volume root is the one component that must be opened by path. It
	// cannot be a reparse point.
	rootWide, err := windows.UTF16PtrFromString(volume + string(filepath.Separator))
	if err != nil {
		return nil, err
	}
	root, err := windows.CreateFile(rootWide, windows.FILE_READ_ATTRIBUTES|windows.FILE_LIST_DIRECTORY,
		shareNoDelete|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, fmt.Errorf("open volume root %q: %w", volume, err)
	}
	chain := &dirChain{handles: []windows.Handle{root}}

	components := splitWindowsComponents(strings.Trim(path[len(volume):], `\/`))
	for i, component := range components {
		if component == ".." {
			chain.close()
			return nil, fmt.Errorf("path component escapes the target directory: %q", path)
		}
		access := uint32(windows.FILE_READ_ATTRIBUTES | windows.READ_CONTROL | windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE)
		var sa *windows.SecurityAttributes
		if i == len(components)-1 {
			access |= finalAccess
			sa = finalSA
		}
		disposition := uint32(windows.FILE_OPEN)
		if create {
			disposition = windows.FILE_OPEN_IF
		}
		handle, err := openRelativeComponent(chain.leaf(), component, access, shareNoDelete, disposition, ntDirOptions, sa)
		if err != nil {
			chain.close()
			return nil, fmt.Errorf("open path component %q: %w", component, err)
		}
		chain.handles = append(chain.handles, handle)
		if err := rejectReparseOrNonDir(handle, component); err != nil {
			chain.close()
			return nil, err
		}
	}
	return chain, nil
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
	sa := &windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	return sa, nil
}

func ownAccountSID() (string, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return "", err
	}
	defer func() { _ = token.Close() }()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

// VerifyPrivateDirHandle confirms, from the handle alone, that the directory is
// a real directory (not a reparse point), is owned by SYSTEM, Administrators or
// the agent's own account, and carries a protected DACL so nothing is
// inherited. Exported for the executor's script staging directory.
func VerifyPrivateDirHandle(handle windows.Handle) error {
	if err := verifyPrivateDirOwner(handle); err != nil {
		return err
	}
	return verifyPrivateDirDACLProtected(handle)
}

// verifyPrivateDirOwner is the half that must NEVER be repaired away: adopting
// a directory another local identity owns is the whole finding.
func verifyPrivateDirOwner(handle windows.Handle) error {
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
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read private directory owner: %w", err)
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

func verifyPrivateDirDACLProtected(handle windows.Handle) error {
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
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
	return nil
}

// applyPrivateDACL replaces the directory's DACL with the explicit restrictive
// one and clears inheritance, through the pinned handle. It is applied
// UNCONDITIONALLY for a private directory — symmetric with the unix side's
// unconditional Fchmod — because "protected" only means "not inheriting": a
// pre-existing directory could carry a protected DACL that still grants
// Everyone full control. The owner is deliberately left alone: changing it
// needs SeRestorePrivilege, and a foreign owner is rejected before we get here.
func applyPrivateDACL(handle windows.Handle) error {
	sa, err := PrivateDirSecurityAttributes()
	if err != nil {
		return err
	}
	dacl, _, err := sa.SecurityDescriptor.DACL()
	if err != nil {
		return fmt.Errorf("read protected DACL: %w", err)
	}
	if err := windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("apply protected DACL: %w", err)
	}
	return nil
}

// VerifyPrivateDir opens path without following a reparse point and applies
// VerifyPrivateDirHandle to the resulting handle. Callers use it right after an
// exclusive CreateDirectory to confirm the directory they just created really
// is a locked-down directory before anything privileged is written into it.
func VerifyPrivateDir(path string) error {
	chain, err := openVerifiedDir(path, false, nil, 0)
	if err != nil {
		return err
	}
	defer chain.close()
	return VerifyPrivateDirHandle(chain.leaf())
}

func ensureDir(path string, mode os.FileMode, private bool) error {
	if !private {
		chain, err := openVerifiedDir(path, true, nil, 0)
		if err != nil {
			return err
		}
		chain.close()
		return nil
	}
	sa, err := PrivateDirSecurityAttributes()
	if err != nil {
		return err
	}
	// WRITE_DAC is requested on the final component so an already-existing
	// directory can be repaired through the same pinned handle rather than by
	// reopening a pathname. A directory's owner always holds WRITE_DAC
	// implicitly, so this does not narrow which directories we can adopt.
	chain, err := openVerifiedDir(path, true, sa, windows.WRITE_DAC)
	if err != nil {
		return err
	}
	defer chain.close()

	// The owner check comes first and is never repaired: it is what stops the
	// agent adopting a directory another local identity created.
	if err := verifyPrivateDirOwner(chain.leaf()); err != nil {
		return err
	}
	if err := applyPrivateDACL(chain.leaf()); err != nil {
		return err
	}
	return verifyPrivateDirDACLProtected(chain.leaf())
}

func installFile(base, relative, source string, mode os.FileMode, modTime time.Time, owner *Owner) ([]error, error) {
	parent := base
	if dir := filepath.Dir(relative); dir != "." {
		parent = filepath.Join(base, dir)
	}
	// The chain stays open for the whole operation, including the publish, so
	// no component can be swapped between the walk and the write.
	chain, err := openVerifiedDir(parent, true, nil, 0)
	if err != nil {
		return nil, fmt.Errorf("open target parent: %w", err)
	}
	defer chain.close()
	parentHandle := chain.leaf()

	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, fmt.Errorf("generate temporary name: %w", err)
	}
	tempName := ".breeze-restore-" + hex.EncodeToString(random[:])
	tempHandle, err := openRelativeComponent(parentHandle, tempName,
		windows.GENERIC_WRITE|windows.DELETE|windows.FILE_WRITE_ATTRIBUTES|windows.FILE_READ_ATTRIBUTES,
		shareFile, windows.FILE_CREATE, ntFileOptions, nil)
	if err != nil {
		return nil, fmt.Errorf("create target temporary file: %w", err)
	}
	temp := os.NewFile(uintptr(tempHandle), tempName)
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			// The temporary may already carry FILE_ATTRIBUTE_READONLY from the
			// manifest mode, which would make the delete below refuse and
			// orphan a .breeze-restore-<hex> file in the caller's tree.
			_ = clearReadOnlyRelative(parentHandle, tempName)
			_ = deleteRelative(parentHandle, tempName)
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
	if owner != nil {
		// Unix uid/gid has no Windows meaning. #5520's walker never records an
		// Owner on Windows, so this only happens for a manifest captured
		// elsewhere; say so rather than silently dropping it.
		warnings = append(warnings, errors.New("unix ownership is not applied on Windows"))
	}
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

	destination := filepath.Base(relative)
	if err := renameRelative(tempHandle, parentHandle, destination); err != nil {
		if !errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.STATUS_ACCESS_DENIED) {
			return nil, fmt.Errorf("publish target file: %w", err)
		}
		// A destination carrying FILE_ATTRIBUTE_READONLY (very common for
		// restored app config, D19) refuses to be replaced. Clear the attribute
		// through a handle opened relative to the SAME pinned parent, so this
		// retry cannot be redirected either, then rename exactly once more.
		if clearErr := clearReadOnlyRelative(parentHandle, destination); clearErr != nil {
			return nil, fmt.Errorf("publish target file: %w", err)
		}
		if retryErr := renameRelative(tempHandle, parentHandle, destination); retryErr != nil {
			return nil, fmt.Errorf("publish target file: %w", retryErr)
		}
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

// renameRelativeExUnsupported latches once a kernel tells us it does not know
// FileRenameInformationEx, so we stop paying for the probe.
var renameRelativeExUnsupported atomic.Bool

// renameRelative publishes the open file at handle as name under parent,
// atomically replacing whatever name currently refers to. RootDirectory is the
// pinned parent handle, so the destination is resolved relative to a directory
// we hold open — never from a path string the kernel would re-resolve.
//
// This deliberately uses the NATIVE NtSetInformationFile rather than Win32's
// SetFileInformationByHandle(FileRenameInfo). The Win32 wrapper does not honour
// a non-NULL RootDirectory — it expects FileName to be a fully qualified path
// and returns ERROR_INVALID_PARAMETER otherwise, which is how the first
// handle-relative attempt failed on a Windows Server 2022 lab host. Only the
// native call gives us the renameat equivalent the rest of the design assumes.
//
// FileRenameInformationEx (class 65) is preferred because POSIX semantics let
// the rename replace a destination that other handles still have open. Without
// it, two restores publishing to the same destination collide: the winner holds
// its handle until installFile returns and the sibling's rename fails with
// STATUS_SHARING_VIOLATION (105 of 200 concurrent installs failed that way on
// the lab host). Class 10 remains the fallback for pre-Server-2016 kernels,
// with a short bounded retry for the same reason.
func renameRelative(handle, parent windows.Handle, name string) error {
	if !renameRelativeExUnsupported.Load() {
		err := setRenameInformation(handle, parent, name, fileRenameInformationEx,
			windows.FILE_RENAME_REPLACE_IF_EXISTS|windows.FILE_RENAME_POSIX_SEMANTICS)
		if err == nil {
			return nil
		}
		switch {
		case errors.Is(err, windows.STATUS_INVALID_INFO_CLASS), errors.Is(err, windows.STATUS_NOT_SUPPORTED):
			// The kernel does not know class 65 at all: latch, and never probe
			// again in this process.
			renameRelativeExUnsupported.Store(true)
		case errors.Is(err, windows.STATUS_INVALID_PARAMETER):
			// Ambiguous — some filesystems (SMB shares, FAT32) answer this for
			// a class they cannot honour, but so does a genuinely malformed
			// request. Fall back for THIS call without latching, since the
			// latch is process-wide and one odd target must not downgrade
			// every later publication.
		default:
			return err
		}
	}
	var err error
	for attempt := 0; attempt < 10; attempt++ {
		err = setRenameInformation(handle, parent, name, windows.FileRenameInformation,
			windows.FILE_RENAME_REPLACE_IF_EXISTS)
		if err == nil || !errors.Is(err, windows.STATUS_SHARING_VIOLATION) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * time.Millisecond)
	}
	return err
}

// fileRenameInformation mirrors FILE_RENAME_INFORMATION (and its Ex twin, which
// has the identical layout). Go lays this out exactly as the NT ABI does on
// x64: the union at 0, four bytes of padding, RootDirectory at 8,
// FileNameLength at 16 and FileName at 20.
type fileRenameInformation struct {
	ReplaceIfExists uint32
	RootDirectory   windows.Handle
	FileNameLength  uint32
	FileName        [1]uint16
}

// setRenameInformation builds the variable-length request. FileNameLength is in
// BYTES and excludes the terminator.
//
// The buffer is offsetof(FileName)+FileNameLength but NEVER shorter than the
// whole struct: the kernel checks Length >= sizeof(FILE_RENAME_INFORMATION)
// (24 on x64) BEFORE it looks at FileNameLength, so a one-character
// destination — 20+2 = 22 — is rejected with STATUS_INFO_LENGTH_MISMATCH. A
// real restore hits this: "…\assure\src\x".
func setRenameInformation(handle, parent windows.Handle, name string, class uint32, flags uint32) error {
	nameUTF16, err := windows.UTF16FromString(name)
	if err != nil {
		return err
	}
	nameLen := len(nameUTF16)*2 - 2
	if nameLen <= 0 {
		return errors.New("publication name is empty")
	}
	var layout fileRenameInformation
	size := int(unsafe.Offsetof(layout.FileName)) + nameLen
	if minimum := int(unsafe.Sizeof(layout)); size < minimum {
		size = minimum
	}
	buf := make([]byte, size)
	info := (*fileRenameInformation)(unsafe.Pointer(&buf[0]))
	info.ReplaceIfExists = flags
	info.RootDirectory = parent
	info.FileNameLength = uint32(nameLen)
	copy((*[windows.MAX_LONG_PATH]uint16)(unsafe.Pointer(&info.FileName[0]))[:nameLen/2:nameLen/2], nameUTF16)

	var iosb windows.IO_STATUS_BLOCK
	return windows.NtSetInformationFile(handle, &iosb, &buf[0], uint32(len(buf)), class)
}

func deleteRelative(parent windows.Handle, name string) error {
	handle, err := openRelativeComponent(parent, name, windows.DELETE, shareFile, windows.FILE_OPEN, ntFileOptions, nil)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	// FILE_DISPOSITION_INFO is a single BOOLEAN DeleteFile, padded to 4 bytes.
	buf := make([]byte, 4)
	buf[0] = 1
	return windows.SetFileInformationByHandle(handle, windows.FileDispositionInfo, &buf[0], uint32(len(buf)))
}

func clearReadOnlyRelative(parent windows.Handle, name string) error {
	handle, err := openRelativeComponent(parent, name,
		windows.FILE_READ_ATTRIBUTES|windows.FILE_WRITE_ATTRIBUTES, shareFile, windows.FILE_OPEN, ntFileOptions, nil)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(handle) }()
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
	chain, err := openVerifiedDir(parent, false, nil, 0)
	if err != nil {
		return nil, err
	}
	defer chain.close()

	name := filepath.Base(relative)
	handle, err := openRelativeComponent(chain.leaf(), name, windows.FILE_READ_ATTRIBUTES,
		shareFile, windows.FILE_OPEN, ntFileOptions, nil)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(handle), filepath.Join(parent, name))
	defer func() { _ = f.Close() }()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return nil, fmt.Errorf("target is a link: %q", name)
	}
	return f.Stat()
}

// installSymlink is refused on Windows. Creating a symbolic link needs
// SeCreateSymbolicLinkPrivilege or developer mode, and #5520's walker never
// records a symlink entry on Windows in the first place — such a manifest can
// only have come from another platform. Failing closed keeps the restore
// honest instead of publishing something that is not a link.
func installSymlink(_, relative, _ string, _ *Owner) error {
	return fmt.Errorf("restoring the symbolic link %q is not supported on Windows", relative)
}

func installDir(base, relative string, mode os.FileMode, applyMode bool, owner *Owner, modTime time.Time) error {
	// openVerifiedDir creates each missing component relative to the previous
	// component's pinned handle and rejects a reparse point at every one, so a
	// directory entry can never be created through an ancestor an earlier pass
	// linked away.
	chain, err := openVerifiedDir(filepath.Join(base, relative), true, nil, windows.FILE_WRITE_ATTRIBUTES)
	if err != nil {
		return fmt.Errorf("open target directory: %w", err)
	}
	defer chain.close()

	if owner != nil {
		return errors.New("unix ownership is not applied on Windows")
	}
	// Windows has no Unix directory mode; the DACL is the equivalent and a
	// restored tree inherits the destination's, which is what an operator
	// restoring into their own tree expects. applyMode is therefore ignored
	// here rather than mistranslated into FILE_ATTRIBUTE_READONLY.
	_ = applyMode
	_ = mode
	if !modTime.IsZero() {
		ft := windows.NsecToFiletime(modTime.UnixNano())
		stamp := int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime)
		basic := fileBasicInfo{LastWriteTime: stamp, ChangeTime: stamp}
		if err := setBasicInfo(chain.leaf(), &basic); err != nil {
			return fmt.Errorf("apply directory modification time: %w", err)
		}
	}
	return nil
}
