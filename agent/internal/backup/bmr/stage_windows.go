//go:build windows

package bmr

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// stagingSDDL is the staging file's descriptor: a protected DACL granting
// full control to SYSTEM and the local Administrators group only.
// stagingSecurityAttributes adds the account the helper runs as when that
// is not SYSTEM (a developer or CI run), so the helper can still open it.
const stagingSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"

func stagingSecurityAttributes() (*windows.SecurityAttributes, error) {
	sddl := stagingSDDL
	if own, err := processAccountSID(); err == nil && own != "" && own != "S-1-5-18" {
		sddl += "(A;;FA;;;" + own + ")"
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, fmt.Errorf("build staging security descriptor: %w", err)
	}
	sa := &windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	return sa, nil
}

func processAccountSID() (string, error) {
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

// extendedPath returns p in the \\?\ form CreateFile needs for a path longer
// than MAX_PATH; os functions do this themselves.
func extendedPath(p string) string {
	if len(p) < 248 || strings.HasPrefix(p, `\\?\`) || !filepath.IsAbs(p) {
		return p
	}
	p = filepath.Clean(p)
	if strings.HasPrefix(p, `\\`) {
		return `\\?\UNC\` + p[2:]
	}
	return `\\?\` + p
}

// createStagingFile creates path exclusively (CREATE_NEW, never through a
// reparse point) with the staging descriptor already in place, so the file
// is never readable by other accounts. The handle shares read and write
// (the provider reopens the path to download into it) and delete (so it
// can be renamed and removed while open), and holds WRITE_DAC/WRITE_OWNER
// to take the target's descriptor before it is published.
func createStagingFile(path string) (*os.File, error) {
	sa, err := stagingSecurityAttributes()
	if err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(extendedPath(path))
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name,
		windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		sa, windows.CREATE_NEW,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "create", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

// applyStagedMetadata gives the staged file, through its handle, what the
// restored file should carry before it is renamed into place:
//
//   - security descriptor: an existing target's owner, group and DACL
//     (protected or inheriting, as the target's was); for a new target, the
//     DACL the parent directory passes on, as a file created there would
//     get;
//   - times: the manifest entry's ModTime as the last-write and last-access
//     time, when recorded.
//
// A step that fails is returned as a fidelity message; the staged file then
// keeps its SYSTEM/Administrators-only DACL, never anything wider.
func applyStagedMetadata(f *os.File, targetPath string, file manifestFile) []string {
	h := windows.Handle(f.Fd())
	var fidelity []string
	if msg := applyTargetSecurity(h, targetPath); msg != "" {
		fidelity = append(fidelity, msg)
	}
	if !file.ModTime.IsZero() {
		ft := windows.NsecToFiletime(file.ModTime.UnixNano())
		if err := windows.SetFileTime(h, nil, &ft, &ft); err != nil {
			fidelity = append(fidelity, fmt.Sprintf("could not apply mtime: %s", err.Error()))
		}
	}
	return fidelity
}

func applyTargetSecurity(staged windows.Handle, targetPath string) string {
	name, err := windows.UTF16PtrFromString(extendedPath(targetPath))
	if err != nil {
		return "could not read the existing file's security descriptor: " + err.Error()
	}
	th, err := windows.CreateFile(name, windows.READ_CONTROL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return inheritParentDACL(staged)
	}
	if err != nil {
		return "could not read the existing file's security descriptor: " + err.Error()
	}
	defer func() { _ = windows.CloseHandle(th) }()

	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(th, &info); err != nil {
		return "could not read the existing file's security descriptor: " + err.Error()
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		// Not a file whose descriptor the restored file should take.
		return inheritParentDACL(staged)
	}

	sd, err := windows.GetSecurityInfo(th, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return "could not read the existing file's security descriptor: " + err.Error()
	}
	owner, _, _ := sd.Owner()
	group, _, _ := sd.Group()
	dacl, _, err := sd.DACL()
	if err != nil {
		return "could not read the existing file's DACL: " + err.Error()
	}
	control, _, _ := sd.Control()
	daclInfo := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.UNPROTECTED_DACL_SECURITY_INFORMATION)
	if control&windows.SE_DACL_PROTECTED != 0 {
		daclInfo = windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION
	}

	// The DACL first: it is what keeps the file's readers the same.
	if err := windows.SetSecurityInfo(staged, windows.SE_FILE_OBJECT, daclInfo, nil, nil, dacl, nil); err != nil {
		return "could not apply the existing file's DACL: " + err.Error()
	}
	if owner == nil {
		return ""
	}
	ownerInfo := windows.SECURITY_INFORMATION(windows.OWNER_SECURITY_INFORMATION)
	if group != nil {
		ownerInfo |= windows.GROUP_SECURITY_INFORMATION
	}
	release := enableRestorePrivilege()
	err = windows.SetSecurityInfo(staged, windows.SE_FILE_OBJECT, ownerInfo, owner, group, nil, nil)
	release()
	if err != nil {
		return "could not apply the existing file's owner: " + err.Error()
	}
	return ""
}

// inheritParentDACL replaces the staged file's private DACL with the ACEs
// its directory passes on. If that leaves no ACE at all (nothing was
// inherited), the private DACL is put back and a fidelity message returned:
// an empty DACL would lock every account out of the restored file.
func inheritParentDACL(staged windows.Handle) string {
	empty, err := windows.SecurityDescriptorFromString("D:")
	if err != nil {
		return "could not inherit the directory's permissions: " + err.Error()
	}
	emptyDACL, _, err := empty.DACL()
	if err != nil {
		return "could not inherit the directory's permissions: " + err.Error()
	}
	if err := windows.SetSecurityInfo(staged, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, emptyDACL, nil); err != nil {
		return "could not inherit the directory's permissions: " + err.Error()
	}
	sd, err := windows.GetSecurityInfo(staged, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err == nil {
		if dacl, _, derr := sd.DACL(); derr == nil && (dacl == nil || dacl.AceCount > 0) {
			return ""
		}
	}
	if sa, saErr := stagingSecurityAttributes(); saErr == nil {
		if private, _, dErr := sa.SecurityDescriptor.DACL(); dErr == nil {
			_ = windows.SetSecurityInfo(staged, windows.SE_FILE_OBJECT,
				windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
				nil, nil, private, nil)
		}
	}
	return "the directory passed on no permissions; the restored file is limited to SYSTEM and Administrators"
}

// enableRestorePrivilege enables SeRestorePrivilege (needed to give a file
// an owner other than the caller) for the returned release's lifetime,
// best effort: when the token lacks it, setting another owner simply fails.
func enableRestorePrivilege() (release func()) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		return func() {}
	}
	name, _ := windows.UTF16PtrFromString("SeRestorePrivilege")
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, name, &luid); err != nil {
		_ = token.Close()
		return func() {}
	}
	state := windows.Tokenprivileges{PrivilegeCount: 1}
	state.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
	var prev windows.Tokenprivileges
	var retLen uint32
	if err := windows.AdjustTokenPrivileges(token, false, &state, uint32(unsafe.Sizeof(prev)), &prev, &retLen); err != nil {
		_ = token.Close()
		return func() {}
	}
	return func() {
		// prev lists only what changed; restoring it undoes exactly that.
		if prev.PrivilegeCount > 0 {
			_ = windows.AdjustTokenPrivileges(token, false, &prev, 0, nil, nil)
		}
		_ = token.Close()
	}
}

// stagingLeftoverOwned reports whether a leftover staging file is owned by
// SYSTEM, Administrators or this helper's account — the owners a staging
// file this helper created can have — so a sweep never removes a file
// another account created.
func stagingLeftoverOwned(path string, _ os.FileInfo) bool {
	sd, err := windows.GetNamedSecurityInfo(extendedPath(path), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return false
	}
	if owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return true
	}
	own, err := processAccountSID()
	return err == nil && own == owner.String()
}

// applyPublishedAttributes runs what can only follow the rename: the
// recorded mode (on Windows only the read-only bit) and then the Windows
// attributes, last, since ReadOnly would block the steps before it.
func applyPublishedAttributes(targetPath string, file manifestFile) []string {
	var out []string
	if file.Mode != 0 {
		if err := chmodFile(targetPath, os.FileMode(file.Mode).Perm()); err != nil {
			out = append(out, fmt.Sprintf("could not reapply mode %o: %s", os.FileMode(file.Mode).Perm(), err.Error()))
		}
	}
	if err := applyWinAttrsFile(targetPath, file.WinAttrs); err != nil {
		out = append(out, fmt.Sprintf("could not reapply windows attributes: %s", err.Error()))
	}
	return out
}
