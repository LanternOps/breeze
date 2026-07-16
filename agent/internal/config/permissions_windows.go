//go:build windows

package config

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The Breeze Helper ("Breeze Assist") runs in the logged-in user's session,
// while the agent (SYSTEM) writes these files. The config dir and agent.yaml
// grant BUILTIN\Users read so the Helper can read the server URL, agent ID, and
// helper-scoped token — restoring the default ProgramData ACL that #568's
// PROTECTED DACL stripped. SYSTEM and Administrators keep full control. The
// directory's Users ACE is read+traverse (FRFX) and intentionally NOT
// inheritable, so it never propagates to secrets.yaml. The full agent/watchdog
// tokens and mTLS keys live ONLY in secrets.yaml, which stays SYSTEM +
// Administrators (never Users).
const (
	windowsConfigDirSDDL  = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FRFX;;;BU)`
	windowsConfigFileSDDL = `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)`
	windowsSecretFileSDDL = `D:P(A;;FA;;;SY)(A;;FA;;;BA)`

	windowsConfigDirCreateSDDL = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FRFX;;;BU)"
	windowsAgentRunDirSDDL     = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

	// windowsProgramDataDirSDDL mirrors the MSI HardenProgramDataAcl action
	// (icacls /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F):
	// SYSTEM and Administrators get full control, container+object inheritable,
	// the DACL is PROTECTED (no inheritance), and BUILTIN\Users gets NOTHING.
	// Unlike the config dir — which intentionally grants Users read so the
	// Breeze Helper can read agent.yaml — the logs/data trees must never be
	// Users-readable or -writable.
	windowsProgramDataDirSDDL = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`
)

const fileDeleteChildAccess = 0x00000040

var (
	mainAgentConfigDirFn            = ConfigDir
	getMainAgentFileInformationFn   = windows.GetFileInformationByHandle
	getMainAgentSecurityInfoFn      = windows.GetSecurityInfo
	setMainAgentSecurityInfoFn      = windows.SetSecurityInfo
	removeMainAgentLockRelativeFn   = removeMainAgentLockRelative
	openMainAgentDirectoryFn        = openMainAgentDirectory
	createMainAgentDirectoryFn      = createMainAgentDirectory
	closeMainAgentDirectoryHandleFn = windows.CloseHandle
)

// PrepareMainAgentLockDir returns a private, non-reparse run directory only
// after proving the ConfigDir and run path names still resolve to the handles
// whose owner and protected DACL were repaired. All security and identity
// failures are fatal; callers must not reinterpret them as lock contention.
func PrepareMainAgentLockDir() (string, error) {
	configPath := mainAgentConfigDirFn()
	configHandle, err := ensureMainAgentDirectory(configPath, windowsConfigDirCreateSDDL)
	if err != nil {
		return "", fmt.Errorf("secure main-agent config directory: %w", err)
	}
	defer closeMainAgentDirectoryHandleFn(configHandle)

	configIdentity, err := inspectMainAgentDirectory(configHandle, "config directory")
	if err != nil {
		return "", err
	}
	if err := hardenAndVerifyMainAgentDirectory(configHandle, windowsConfigDirCreateSDDL, "config directory"); err != nil {
		return "", err
	}
	if err := verifyMainAgentDirectoryPath(configPath, configIdentity, "", "config directory"); err != nil {
		return "", err
	}

	runPath := filepath.Join(configPath, "run")
	runHandle, err := ensureMainAgentDirectory(runPath, windowsAgentRunDirSDDL)
	if err != nil {
		return "", fmt.Errorf("secure main-agent run directory: %w", err)
	}
	defer closeMainAgentDirectoryHandleFn(runHandle)

	runIdentity, err := inspectMainAgentDirectory(runHandle, "run directory")
	if err != nil {
		return "", err
	}
	originalTrusted, err := mainAgentHandleHasTrustedOwner(runHandle, "run directory")
	if err != nil {
		return "", err
	}
	if err := hardenAndVerifyMainAgentDirectory(runHandle, windowsAgentRunDirSDDL, "run directory"); err != nil {
		return "", err
	}
	if !originalTrusted {
		if err := removeMainAgentLockRelativeFn(runHandle, "agent.lock"); err != nil {
			return "", fmt.Errorf("sanitize hostile main-agent lock: %w", err)
		}
	}
	if err := verifyMainAgentDirectoryPath(runPath, runIdentity, windowsAgentRunDirSDDL, "run directory"); err != nil {
		return "", err
	}
	return runPath, nil
}

// MainAgentLockDirectory pins the verified ConfigDir and run namespace while
// the main-agent lock is held. Handle is the run directory used as the root
// for handle-relative lock acquisition.
type MainAgentLockDirectory struct {
	mu           sync.Mutex
	configHandle windows.Handle
	runHandle    windows.Handle
}

func (d *MainAgentLockDirectory) Handle() windows.Handle { return d.runHandle }

func (d *MainAgentLockDirectory) Close() error {
	d.mu.Lock()
	configHandle := d.configHandle
	runHandle := d.runHandle
	d.configHandle = windows.InvalidHandle
	d.runHandle = windows.InvalidHandle
	d.mu.Unlock()
	var firstErr error
	if runHandle != windows.InvalidHandle {
		if err := closeMainAgentDirectoryHandleFn(runHandle); err != nil {
			firstErr = err
		}
	}
	if configHandle != windows.InvalidHandle {
		if err := closeMainAgentDirectoryHandleFn(configHandle); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// OpenPreparedMainAgentLockDir revalidates and pins the current ConfigDir and
// its handle-relative run child without delete/write sharing. A hostile
// pre-existing rename/write handle therefore makes this fail closed, and no
// new namespace mutation handle can open until MainAgentLockDirectory.Close.
func OpenPreparedMainAgentLockDir() (*MainAgentLockDirectory, error) {
	configPath := mainAgentConfigDirFn()
	configHandle, err := openMainAgentDirectoryPinned(configPath)
	if err != nil {
		return nil, fmt.Errorf("open prepared config directory: %w", err)
	}

	_, err = inspectMainAgentDirectory(configHandle, "prepared config directory")
	if err != nil {
		_ = closeMainAgentDirectoryHandleFn(configHandle)
		return nil, err
	}
	if err := verifyMainAgentDirectorySecurity(configHandle, windowsConfigDirCreateSDDL, "prepared config directory"); err != nil {
		_ = closeMainAgentDirectoryHandleFn(configHandle)
		return nil, err
	}
	runHandle, err := openMainAgentChildDirectory(configHandle, "run")
	if err != nil {
		_ = closeMainAgentDirectoryHandleFn(configHandle)
		return nil, fmt.Errorf("open run relative to verified config handle: %w", err)
	}
	if _, err := inspectMainAgentDirectory(runHandle, "prepared run directory"); err != nil {
		_ = closeMainAgentDirectoryHandleFn(runHandle)
		_ = closeMainAgentDirectoryHandleFn(configHandle)
		return nil, err
	}
	if err := verifyMainAgentDirectorySecurity(runHandle, windowsAgentRunDirSDDL, "prepared run directory"); err != nil {
		_ = closeMainAgentDirectoryHandleFn(runHandle)
		_ = closeMainAgentDirectoryHandleFn(configHandle)
		return nil, err
	}
	return &MainAgentLockDirectory{configHandle: configHandle, runHandle: runHandle}, nil
}

func ensureMainAgentDirectory(path, sddl string) (windows.Handle, error) {
	h, err := openMainAgentDirectoryFn(path)
	if err == nil {
		return h, nil
	}
	if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return windows.InvalidHandle, fmt.Errorf("open %s without following reparse points: %w", path, err)
	}
	if err := createMainAgentDirectoryFn(path, sddl); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return windows.InvalidHandle, fmt.Errorf("create %s atomically with private security: %w", path, err)
	}
	h, err = openMainAgentDirectoryFn(path)
	if err != nil {
		return windows.InvalidHandle, fmt.Errorf("open newly secured %s without following reparse points: %w", path, err)
	}
	return h, nil
}

func openMainAgentDirectory(path string) (windows.Handle, error) {
	return openMainAgentDirectoryWithShare(path, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE)
}

func openMainAgentDirectoryPinned(path string) (windows.Handle, error) {
	return openMainAgentDirectoryWithShare(path, windows.FILE_SHARE_READ)
}

func openMainAgentDirectoryWithShare(path string, share uint32) (windows.Handle, error) {
	path16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	return windows.CreateFile(
		path16,
		windows.FILE_LIST_DIRECTORY|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|fileDeleteChildAccess|windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER,
		share,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
}

func openMainAgentChildDirectory(parent windows.Handle, name string) (windows.Handle, error) {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return windows.InvalidHandle, err
	}
	attrs := &windows.OBJECT_ATTRIBUTES{
		Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory: parent,
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE,
	}
	var (
		h    windows.Handle
		iosb windows.IO_STATUS_BLOCK
	)
	if err := windows.NtCreateFile(
		&h,
		windows.FILE_LIST_DIRECTORY|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|fileDeleteChildAccess|windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER|windows.SYNCHRONIZE,
		attrs,
		&iosb,
		nil,
		0,
		windows.FILE_SHARE_READ,
		windows.FILE_OPEN,
		windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
		0,
		0,
	); err != nil {
		return windows.InvalidHandle, err
	}
	return h, nil
}

func createMainAgentDirectory(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("parse directory security descriptor: %w", err)
	}
	path16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
		InheritHandle:      0,
	}
	return windows.CreateDirectory(path16, sa)
}

type mainAgentDirectoryIdentity struct {
	volume    uint32
	indexHigh uint32
	indexLow  uint32
}

func inspectMainAgentDirectory(h windows.Handle, label string) (mainAgentDirectoryIdentity, error) {
	var info windows.ByHandleFileInformation
	if err := getMainAgentFileInformationFn(h, &info); err != nil {
		return mainAgentDirectoryIdentity{}, fmt.Errorf("inspect %s handle: %w", label, err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return mainAgentDirectoryIdentity{}, fmt.Errorf("refuse reparse-point %s", label)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return mainAgentDirectoryIdentity{}, fmt.Errorf("refuse non-directory %s", label)
	}
	return mainAgentDirectoryIdentity{
		volume:    info.VolumeSerialNumber,
		indexHigh: info.FileIndexHigh,
		indexLow:  info.FileIndexLow,
	}, nil
}

func verifyMainAgentDirectoryPath(path string, want mainAgentDirectoryIdentity, securitySDDL, label string) error {
	reopened, err := openMainAgentDirectoryFn(path)
	if err != nil {
		return fmt.Errorf("reopen %s for identity verification: %w", label, err)
	}
	defer closeMainAgentDirectoryHandleFn(reopened)
	got, err := inspectMainAgentDirectory(reopened, label)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%s path identity changed during security hardening", label)
	}
	if securitySDDL != "" {
		if err := verifyMainAgentDirectorySecurity(reopened, securitySDDL, label); err != nil {
			return err
		}
	}
	return nil
}

func hardenAndVerifyMainAgentDirectory(h windows.Handle, sddl, label string) error {
	want, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("parse %s security descriptor: %w", label, err)
	}
	owner, _, err := want.Owner()
	if err != nil {
		return fmt.Errorf("extract %s owner: %w", label, err)
	}
	group, _, err := want.Group()
	if err != nil {
		return fmt.Errorf("extract %s group: %w", label, err)
	}
	dacl, _, err := want.DACL()
	if err != nil {
		return fmt.Errorf("extract %s DACL: %w", label, err)
	}
	if err := setMainAgentSecurityInfoFn(
		h,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner,
		group,
		dacl,
		nil,
	); err != nil {
		return fmt.Errorf("set %s trusted owner and protected DACL through handle: %w", label, err)
	}
	return verifyMainAgentDirectorySecurityDescriptor(h, want, label)
}

func verifyMainAgentDirectorySecurity(h windows.Handle, sddl, label string) error {
	want, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("parse expected %s security descriptor: %w", label, err)
	}
	return verifyMainAgentDirectorySecurityDescriptor(h, want, label)
}

func verifyMainAgentDirectorySecurityDescriptor(h windows.Handle, want *windows.SECURITY_DESCRIPTOR, label string) error {
	got, err := getMainAgentSecurityInfoFn(
		h,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
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
	if !trustedMainAgentOwner(owner) {
		return fmt.Errorf("%s owner is not LocalSystem or BUILTIN\\Administrators: %v", label, owner)
	}
	group, _, err := got.Group()
	if err != nil {
		return fmt.Errorf("read %s group: %w", label, err)
	}
	if group == nil || !group.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return fmt.Errorf("%s group is not BUILTIN\\Administrators: %v", label, group)
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
	wantDACL, _, err := want.DACL()
	if err != nil {
		return fmt.Errorf("read expected %s DACL: %w", label, err)
	}
	if !equalMainAgentACL(gotDACL, wantDACL) {
		return fmt.Errorf("%s DACL does not match its fixed security policy", label)
	}
	return nil
}

func mainAgentHandleHasTrustedOwner(h windows.Handle, label string) (bool, error) {
	sd, err := getMainAgentSecurityInfoFn(
		h,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return false, fmt.Errorf("read original %s owner through handle: %w", label, err)
	}
	if sd == nil {
		return false, fmt.Errorf("original %s has no security descriptor", label)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return false, fmt.Errorf("read original %s owner: %w", label, err)
	}
	if _, _, err := sd.DACL(); err != nil {
		return false, fmt.Errorf("inspect original %s DACL: %w", label, err)
	}
	return trustedMainAgentOwner(owner), nil
}

func trustedMainAgentOwner(owner *windows.SID) bool {
	return owner != nil && (owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid))
}

func equalMainAgentACL(a, b *windows.ACL) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.AceCount != b.AceCount {
		return false
	}
	for i := uint32(0); i < uint32(a.AceCount); i++ {
		var aACE, bACE *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(a, i, &aACE) != nil || windows.GetAce(b, i, &bACE) != nil {
			return false
		}
		if aACE.Header.AceType != bACE.Header.AceType ||
			aACE.Header.AceFlags != bACE.Header.AceFlags ||
			aACE.Mask != bACE.Mask {
			return false
		}
		aSID := (*windows.SID)(unsafe.Pointer(&aACE.SidStart))
		bSID := (*windows.SID)(unsafe.Pointer(&bACE.SidStart))
		if !aSID.Equals(bSID) {
			return false
		}
	}
	return true
}

func removeMainAgentLockRelative(dir windows.Handle, name string) error {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return err
	}
	attrs := &windows.OBJECT_ATTRIBUTES{
		Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory: dir,
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE,
	}
	var (
		lock windows.Handle
		iosb windows.IO_STATUS_BLOCK
	)
	err = windows.NtCreateFile(
		&lock,
		windows.DELETE|windows.FILE_READ_ATTRIBUTES,
		attrs,
		&iosb,
		nil,
		0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		windows.FILE_OPEN,
		windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT,
		0,
		0,
	)
	if err != nil {
		if err == windows.STATUS_NO_SUCH_FILE || err == windows.STATUS_OBJECT_NAME_NOT_FOUND || err == windows.STATUS_OBJECT_PATH_NOT_FOUND {
			return nil
		}
		return fmt.Errorf("open hostile lock relative to verified run handle: %w", err)
	}
	defer windows.CloseHandle(lock)
	deleteFile := byte(1)
	if err := windows.SetFileInformationByHandle(
		lock,
		windows.FileDispositionInfo,
		(*byte)(unsafe.Pointer(&deleteFile)),
		uint32(unsafe.Sizeof(deleteFile)),
	); err != nil {
		return fmt.Errorf("mark hostile lock for deletion through relative handle: %w", err)
	}
	return nil
}

func enforceConfigDirPermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigDirSDDL)
}

func enforceConfigFilePermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigFileSDDL)
}

func enforceSecretFilePermissionsImpl(path string) error {
	return applyWindowsDACL(path, windowsSecretFileSDDL)
}

// enforceSecretFilePermissions is a package-level var so tests can inject a
// failure to verify that SaveTo propagates it as a fatal error. Production
// code always routes through enforceSecretFilePermissionsImpl.
var enforceSecretFilePermissions = enforceSecretFilePermissionsImpl

// enforceProgramDataDirPermissions re-applies the PROTECTED DACL (SYSTEM +
// Administrators full, no Users) to a ProgramData logs/data dir, self-healing
// the drift left when the MSI HardenProgramDataAcl action was skipped or
// blocked. See permissions_drift.go.
func enforceProgramDataDirPermissions(path string) error {
	return applyWindowsDACL(path, windowsProgramDataDirSDDL)
}

// programDataDirACLDrifted reports whether path still carries a BUILTIN\Users
// allow ACE — the signature of the default ProgramData ACL, i.e. the MSI
// hardening never ran or was blocked. A hardened dir grants only SYSTEM and
// Administrators, so the presence of a Users ACE is the drift signal.
func programDataDirACLDrifted(path string) (bool, error) {
	usersSID, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		return false, fmt.Errorf("create Users SID: %w", err)
	}
	sd, err := windows.GetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return false, fmt.Errorf("get security info on %s: %w", path, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return false, fmt.Errorf("extract DACL on %s: %w", path, err)
	}
	if dacl == nil {
		return false, nil
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			continue
		}
		aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if aceSID.Equals(usersSID) {
			return true, nil
		}
	}
	return false, nil
}

func applyWindowsDACL(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("parse DACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("extract DACL: %w", err)
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	); err != nil {
		return fmt.Errorf("set DACL on %s: %w", path, err)
	}
	return nil
}
