//go:build windows

package agentapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"golang.org/x/sys/windows"
)

const windowsMainAgentLockSDDL = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"

var errMainAgentLockContended = errors.New("main-agent lock contended")

type mainAgentLockDirectory interface {
	Handle() windows.Handle
	Close() error
}

type openedMainAgentLock struct {
	handle    windows.Handle
	directory mainAgentLockDirectory
}

// mainAgentLockMetadata is an explicit allowlist. Future ProcessStartup fields
// do not enter ProgramData lock metadata without a deliberate security review.
type mainAgentLockMetadata struct {
	Binary             string         `json:"binary"`
	ExecutablePath     string         `json:"executablePath"`
	PID                int            `json:"pid"`
	ParentPID          int            `json:"parentPid"`
	WindowsSessionID   uint32         `json:"windowsSessionId"`
	LaunchMode         string         `json:"launchMode"`
	HelperRole         ipc.HelperRole `json:"helperRole,omitempty"`
	LifecycleKey       string         `json:"lifecycleKey,omitempty"`
	CompanionHelper    bool           `json:"companionHelper"`
	MainBinaryFallback bool           `json:"mainBinaryFallback"`
	Version            string         `json:"version"`
	CreatedAt          time.Time      `json:"createdAt"`
}

func mainAgentLockMetadataFrom(meta ProcessStartup) mainAgentLockMetadata {
	return mainAgentLockMetadata{
		Binary:             meta.Binary,
		ExecutablePath:     meta.ExecutablePath,
		PID:                meta.PID,
		ParentPID:          meta.ParentPID,
		WindowsSessionID:   meta.WindowsSessionID,
		LaunchMode:         meta.LaunchMode,
		HelperRole:         meta.HelperRole,
		LifecycleKey:       meta.LifecycleKey,
		CompanionHelper:    meta.CompanionHelper,
		MainBinaryFallback: meta.MainBinaryFallback,
		Version:            meta.Version,
		CreatedAt:          meta.CreatedAt,
	}
}

var (
	prepareMainAgentLockDirFn      = config.PrepareMainAgentLockDir
	openMainAgentLockFn            = openMainAgentLock
	openPreparedMainAgentLockDirFn = openPreparedMainAgentLockDir
	openMainAgentLockRelativeFn    = openMainAgentLockRelative
	getMainAgentLockInfoFn         = windows.GetFileInformationByHandle
	hardenAndVerifyLockHandleFn    = hardenAndVerifyLockHandle
)

type fileMainAgentGuard struct {
	mu   sync.Mutex
	file *os.File
	dir  mainAgentLockDirectory
}

func acquireMainAgentGuard(meta ProcessStartup) (mainAgentGuard, error) {
	dir, err := prepareMainAgentLockDirFn()
	if err != nil {
		return nil, fmt.Errorf("prepare instance-lock directory: %w", err)
	}
	path := filepath.Join(dir, mainAgentLockFile)
	opened, err := openMainAgentLockFn(path)
	if err != nil {
		if errors.Is(err, errMainAgentLockContended) {
			return nil, ErrMainAgentAlreadyRunning
		}
		return nil, fmt.Errorf("open main-agent lock: %w", err)
	}
	h := opened.handle
	f := os.NewFile(uintptr(h), path)
	if f == nil {
		_ = windows.CloseHandle(h)
		_ = opened.directory.Close()
		return nil, errors.New("wrap main-agent lock handle")
	}

	var info windows.ByHandleFileInformation
	if err := getMainAgentLockInfoFn(h, &info); err != nil {
		_ = f.Close()
		_ = opened.directory.Close()
		return nil, fmt.Errorf("inspect main-agent lock: %w", err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = f.Close()
		_ = opened.directory.Close()
		return nil, errors.New("refuse reparse-point main-agent lock")
	}
	if err := hardenAndVerifyLockHandleFn(h); err != nil {
		_ = f.Close()
		_ = opened.directory.Close()
		return nil, fmt.Errorf("verify main-agent lock security: %w", err)
	}
	if err := f.Truncate(0); err != nil {
		_ = f.Close()
		_ = opened.directory.Close()
		return nil, fmt.Errorf("truncate main-agent lock metadata: %w", err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		_ = f.Close()
		_ = opened.directory.Close()
		return nil, fmt.Errorf("seek main-agent lock metadata: %w", err)
	}
	if err := json.NewEncoder(f).Encode(mainAgentLockMetadataFrom(meta)); err != nil {
		_ = f.Close()
		_ = opened.directory.Close()
		return nil, fmt.Errorf("write main-agent lock metadata: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = opened.directory.Close()
		return nil, fmt.Errorf("flush main-agent lock metadata: %w", err)
	}
	return &fileMainAgentGuard{file: f, dir: opened.directory}, nil
}

func openPreparedMainAgentLockDir() (mainAgentLockDirectory, error) {
	return config.OpenPreparedMainAgentLockDir()
}

func openMainAgentLock(path string) (openedMainAgentLock, error) {
	if filepath.Base(path) != mainAgentLockFile {
		return openedMainAgentLock{}, fmt.Errorf("unexpected main-agent lock name %q", filepath.Base(path))
	}
	dir, err := openPreparedMainAgentLockDirFn()
	if err != nil {
		return openedMainAgentLock{}, fmt.Errorf("open verified main-agent run directory: %w", err)
	}
	h, err := openMainAgentLockRelativeFn(dir.Handle(), mainAgentLockFile)
	if err != nil {
		_ = dir.Close()
		if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return openedMainAgentLock{}, errMainAgentLockContended
		}
		return openedMainAgentLock{}, fmt.Errorf("open final main-agent lock relative to verified run handle: %w", err)
	}
	return openedMainAgentLock{handle: h, directory: dir}, nil
}

func openMainAgentLockRelative(runHandle windows.Handle, name string) (windows.Handle, error) {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return windows.InvalidHandle, fmt.Errorf("encode relative main-agent lock name: %w", err)
	}
	sa, err := privateLockSecurityAttributes()
	if err != nil {
		return windows.InvalidHandle, fmt.Errorf("build main-agent lock security: %w", err)
	}
	attrs := &windows.OBJECT_ATTRIBUTES{
		Length:             uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory:      runHandle,
		ObjectName:         objectName,
		Attributes:         windows.OBJ_CASE_INSENSITIVE,
		SecurityDescriptor: sa.SecurityDescriptor,
	}
	var (
		h    windows.Handle
		iosb windows.IO_STATUS_BLOCK
	)
	err = windows.NtCreateFile(
		&h,
		windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER,
		attrs,
		&iosb,
		nil,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
		windows.FILE_OPEN_IF,
		windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT,
		0,
		0,
	)
	if err == windows.STATUS_SHARING_VIOLATION {
		return windows.InvalidHandle, windows.ERROR_SHARING_VIOLATION
	}
	if err == windows.STATUS_FILE_LOCK_CONFLICT || err == windows.STATUS_LOCK_NOT_GRANTED {
		return windows.InvalidHandle, windows.ERROR_LOCK_VIOLATION
	}
	if err != nil {
		return windows.InvalidHandle, err
	}
	return h, nil
}

func privateLockSecurityAttributes() (*windows.SecurityAttributes, error) {
	sd, err := windows.SecurityDescriptorFromString(windowsMainAgentLockSDDL)
	if err != nil {
		return nil, fmt.Errorf("parse private lock security descriptor: %w", err)
	}
	return &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
		InheritHandle:      0,
	}, nil
}

func hardenAndVerifyLockHandle(h windows.Handle) error {
	before, err := mainAgentHandleIdentity(h)
	if err != nil {
		return err
	}
	want, err := windows.SecurityDescriptorFromString(windowsMainAgentLockSDDL)
	if err != nil {
		return fmt.Errorf("parse lock security descriptor: %w", err)
	}
	owner, _, err := want.Owner()
	if err != nil {
		return fmt.Errorf("extract lock owner: %w", err)
	}
	group, _, err := want.Group()
	if err != nil {
		return fmt.Errorf("extract lock group: %w", err)
	}
	dacl, _, err := want.DACL()
	if err != nil {
		return fmt.Errorf("extract lock DACL: %w", err)
	}
	if err := windows.SetSecurityInfo(
		h,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner,
		group,
		dacl,
		nil,
	); err != nil {
		return fmt.Errorf("set lock owner and protected DACL: %w", err)
	}
	after, err := mainAgentHandleIdentity(h)
	if err != nil {
		return err
	}
	if before != after {
		return errors.New("main-agent lock handle identity changed during hardening")
	}
	if after.attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("main-agent lock became a reparse point during hardening")
	}
	return verifyMainAgentLockSecurity(h, want)
}

type mainAgentLockIdentity struct {
	volume     uint32
	indexHigh  uint32
	indexLow   uint32
	attributes uint32
}

func mainAgentHandleIdentity(h windows.Handle) (mainAgentLockIdentity, error) {
	var info windows.ByHandleFileInformation
	if err := getMainAgentLockInfoFn(h, &info); err != nil {
		return mainAgentLockIdentity{}, fmt.Errorf("read main-agent lock identity: %w", err)
	}
	return mainAgentLockIdentity{
		volume:     info.VolumeSerialNumber,
		indexHigh:  info.FileIndexHigh,
		indexLow:   info.FileIndexLow,
		attributes: info.FileAttributes,
	}, nil
}

func verifyMainAgentLockSecurity(h windows.Handle, want *windows.SECURITY_DESCRIPTOR) error {
	got, err := windows.GetSecurityInfo(
		h,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return fmt.Errorf("read lock security: %w", err)
	}
	if got == nil {
		return errors.New("lock has no security descriptor")
	}
	owner, _, err := got.Owner()
	if err != nil {
		return fmt.Errorf("read lock owner: %w", err)
	}
	if owner == nil || (!owner.IsWellKnown(windows.WinLocalSystemSid) && !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid)) {
		return fmt.Errorf("lock owner is not LocalSystem or BUILTIN\\Administrators: %v", owner)
	}
	group, _, err := got.Group()
	if err != nil {
		return fmt.Errorf("read lock group: %w", err)
	}
	if group == nil || !group.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return fmt.Errorf("lock group is not BUILTIN\\Administrators: %v", group)
	}
	return verifyProtectedExactDACL(got, want, "main-agent lock")
}

func verifyProtectedExactDACL(got, want *windows.SECURITY_DESCRIPTOR, object string) error {
	control, _, err := got.Control()
	if err != nil {
		return fmt.Errorf("read %s security control: %w", object, err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return fmt.Errorf("%s DACL is not protected", object)
	}
	gotDACL, _, err := got.DACL()
	if err != nil {
		return fmt.Errorf("read %s DACL: %w", object, err)
	}
	wantDACL, _, err := want.DACL()
	if err != nil {
		return fmt.Errorf("read expected %s DACL: %w", object, err)
	}
	if !equalWindowsACL(gotDACL, wantDACL) {
		return fmt.Errorf("%s DACL does not match the private SY/BA policy", object)
	}
	return nil
}

func equalWindowsACL(a, b *windows.ACL) bool {
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

func (g *fileMainAgentGuard) Close() error {
	g.mu.Lock()
	f := g.file
	dir := g.dir
	g.file = nil
	g.dir = nil
	g.mu.Unlock()
	var firstErr error
	if f != nil {
		firstErr = f.Close()
	}
	if dir != nil {
		if err := dir.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
