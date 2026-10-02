//go:build windows

package config

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// The user-private descriptors for a registered user workspace (see
// user_workspace.go). %[1]s is the caller's own user SID: the one owner every
// token may assign, elevated or not (#7620). The DACL is PROTECTED, so nothing
// inherited from %TEMP% survives, and grants only that user, SYSTEM and
// Administrators — never BUILTIN\Users, which the machine-wide config dir
// grants for the Helper. The directory ACEs are inheritable so the log file
// and atomic-write temp files created inside start out private too.
const (
	userWorkspaceDirSDDLFormat  = `O:%[1]sD:P(A;OICI;FA;;;%[1]s)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`
	userWorkspaceFileSDDLFormat = `D:P(A;;FA;;;%[1]s)(A;;FA;;;SY)(A;;FA;;;BA)`
)

// currentUserSIDFn returns the user SID of the effective token: the thread's
// impersonation token when there is one, else the process token. Production
// never impersonates here, so this is the process user; tests impersonate a
// filtered token to run as a standard user would.
var currentUserSIDFn = func() (*windows.SID, error) {
	user, err := windows.GetCurrentThreadEffectiveToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("read the current token user: %w", err)
	}
	return user.User.Sid.Copy()
}

func userWorkspaceSDDL(format string) (string, error) {
	sid, err := currentUserSIDFn()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(format, sid.String()), nil
}

// secureUserWorkspaceDir creates path with the user-private directory
// descriptor applied atomically, or opens an existing path WITHOUT following
// reparse points, refuses a reparse point or non-directory, writes the owner
// and protected DACL through that handle, verifies them, and finally checks
// the path still names the same directory. Same handle discipline as
// PrepareMainAgentLockDir, with the caller's own user as owner.
func secureUserWorkspaceDir(path string) error {
	const label = "user workspace"
	sddl, err := userWorkspaceSDDL(userWorkspaceDirSDDLFormat)
	if err != nil {
		return err
	}
	want, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("parse %s security descriptor: %w", label, err)
	}
	owner, _, err := want.Owner()
	if err != nil {
		return fmt.Errorf("extract %s owner: %w", label, err)
	}
	dacl, _, err := want.DACL()
	if err != nil {
		return fmt.Errorf("extract %s DACL: %w", label, err)
	}

	h, err := ensureMainAgentDirectory(path, sddl)
	if err != nil {
		return fmt.Errorf("secure %s: %w", label, err)
	}
	defer func() { _ = closeMainAgentDirectoryHandleFn(h) }()

	identity, err := inspectMainAgentDirectory(h, label)
	if err != nil {
		return fmt.Errorf("%w: %s", err, path)
	}
	// A directory that already existed is adopted only if it is ours (or
	// SYSTEM's / Administrators'): one another account created must not be
	// taken over just because its DACL happens to let us, the same refusal
	// the Unix variant makes on a foreign uid.
	if err := checkUserWorkspaceOriginalOwner(h, owner, label); err != nil {
		return fmt.Errorf("%w: %s", err, path)
	}
	if err := setMainAgentSecurityInfoFn(
		h,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner,
		nil,
		dacl,
		nil,
	); err != nil {
		return fmt.Errorf("set %s owner and protected DACL on %s through handle: %w", label, path, err)
	}
	if err := verifyUserWorkspaceSecurity(h, owner, dacl, label); err != nil {
		return fmt.Errorf("%w: %s", err, path)
	}
	if err := verifyMainAgentDirectoryPath(path, identity, "", label); err != nil {
		return fmt.Errorf("%w: %s", err, path)
	}
	return nil
}

func checkUserWorkspaceOriginalOwner(h windows.Handle, user *windows.SID, label string) error {
	sd, err := getMainAgentSecurityInfoFn(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read original %s owner through handle: %w", label, err)
	}
	if sd == nil {
		return fmt.Errorf("original %s has no security descriptor", label)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("read original %s owner: %w", label, err)
	}
	if owner != nil && (owner.Equals(user) || trustedMainAgentOwner(owner)) {
		return nil
	}
	return fmt.Errorf("refuse %s owned by %v: not the current user, SYSTEM or Administrators", label, owner)
}

func verifyUserWorkspaceSecurity(h windows.Handle, wantOwner *windows.SID, wantDACL *windows.ACL, label string) error {
	got, err := getMainAgentSecurityInfoFn(h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read %s owner and DACL through handle: %w", label, err)
	}
	if got == nil {
		return fmt.Errorf("%s has no security descriptor", label)
	}
	owner, _, err := got.Owner()
	if err != nil {
		return fmt.Errorf("read %s owner: %w", label, err)
	}
	if owner == nil || !owner.Equals(wantOwner) {
		return fmt.Errorf("%s owner is %v, not the current user %v", label, owner, wantOwner)
	}
	control, _, err := got.Control()
	if err != nil {
		return fmt.Errorf("read %s DACL control: %w", label, err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return fmt.Errorf("%s DACL is not protected", label)
	}
	gotDACL, _, err := got.DACL()
	if err != nil {
		return fmt.Errorf("read %s DACL: %w", label, err)
	}
	if !equalMainAgentACL(gotDACL, wantDACL) {
		return fmt.Errorf("%s DACL does not match the user-private policy", label)
	}
	return nil
}

// applyUserWorkspaceFileDACL writes the user-private PROTECTED DACL onto a
// file inside the workspace. The owner is left as created: the file was just
// written by this process, so it already is the caller (or, for an elevated
// administrator, BUILTIN\Administrators by token default).
func applyUserWorkspaceFileDACL(path string) error {
	sddl, err := userWorkspaceSDDL(userWorkspaceFileSDDLFormat)
	if err != nil {
		return err
	}
	return applyWindowsDACL(path, sddl)
}

// workspaceOwnerSID returns the SID of the user this support session runs as,
// which VerifyProgramDataPath then accepts as an owner and writer inside the
// session's private folder, or "" to accept no one extra.
//
// "" when the session runs with Administrators enabled (elevated): the folder
// grants the user SID, so a non-elevated process of the same user could swap
// a file between its check and the elevated process loading it, a UAC bypass.
// An elevated session therefore trusts only SYSTEM/Administrators-controlled
// files there, which refuses the downloaded codec (the desktop falls back to
// the WebSocket stream). Also "" if the token cannot be read: fail closed.
func workspaceOwnerSID() string {
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return ""
	}
	// Token 0: the thread's effective token (impersonation token if any).
	if elevated, err := windows.Token(0).IsMember(admins); err != nil || elevated {
		return ""
	}
	user, err := windows.GetCurrentThreadEffectiveToken().GetTokenUser()
	if err != nil {
		return ""
	}
	return user.User.Sid.String()
}
