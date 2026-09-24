//go:build windows

package backup

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/securefs"
)

var (
	modadvapi32 = windows.NewLazySystemDLL("advapi32.dll")
	modntdll    = windows.NewLazySystemDLL("ntdll.dll")

	procRtlValidRelativeSecurityDescriptor = modntdll.NewProc("RtlValidRelativeSecurityDescriptor")
)

// openNoFollow opens path for access WITHOUT following a reparse point in
// the final component (FILE_FLAG_OPEN_REPARSE_POINT) and with
// FILE_FLAG_BACKUP_SEMANTICS, which both allows opening a directory and lets
// an enabled SeBackupPrivilege/SeRestorePrivilege grant READ_CONTROL /
// WRITE_DAC / WRITE_OWNER regardless of the object's own DACL. Security-only
// access rights (READ_CONTROL, WRITE_DAC, WRITE_OWNER, ACCESS_SYSTEM_SECURITY)
// never conflict with another opener's share mode, so this works on files
// held open exclusively (a live registry hive, for instance).
//
// securefs has no exported Windows helper for this: its no-follow opens
// (openVerifiedDir/openRelativeComponent) are unexported and walk a
// base+relative pair rather than taking an absolute path.
//
// Residual risk: only the FINAL component is opened no-follow. A junction
// or symlink swapped into an INTERMEDIATE component would still redirect
// it. That is why the restore never applies a descriptor through this: it
// uses securefs's pinned handles instead (securityApplier).
func openNoFollow(path string, access uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, fmt.Errorf("encode path %q: %w", path, err)
	}
	return windows.CreateFile(p, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// captureSecurityInfo returns the SECURITY_INFORMATION bitmask capture
// requests: owner+group+DACL always, plus SACL only while this process holds
// SeSecurityPrivilege (see hasSecurityPrivilege) — requesting it without the
// privilege fails the whole call.
func captureSecurityInfo() (info windows.SECURITY_INFORMATION, access uint32) {
	info = windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION
	access = windows.READ_CONTROL
	if hasSecurityPrivilege.Load() {
		info |= windows.SACL_SECURITY_INFORMATION
		access |= windows.ACCESS_SYSTEM_SECURITY
	}
	return info, access
}

// fileSecurity captures path's self-relative security descriptor from a
// no-follow handle (openNoFollow): a symlink/junction's OWN descriptor, never
// its target's. The returned bytes are an independent copy.
func fileSecurity(path string) ([]byte, error) {
	info, access := captureSecurityInfo()
	h, err := openNoFollow(path, access)
	if err != nil {
		return nil, fmt.Errorf("open %q for security capture: %w", path, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, info)
	if err != nil {
		return nil, fmt.Errorf("GetSecurityInfo on %q: %w", path, err)
	}
	n := sd.Length()
	if n == 0 {
		return nil, fmt.Errorf("GetSecurityInfo on %q returned an empty security descriptor", path)
	}
	return append([]byte(nil), unsafe.Slice((*byte)(unsafe.Pointer(sd)), n)...), nil
}

// alignedSD copies sd into pointer-aligned Go memory so it can be passed as
// a *windows.SECURITY_DESCRIPTOR (a struct with pointer fields — checkptr
// rejects a misaligned conversion, and a base64-decoded []byte carries no
// alignment guarantee).
func alignedSD(sd []byte) *windows.SECURITY_DESCRIPTOR {
	const psize = int(unsafe.Sizeof(uintptr(0)))
	buf := make([]uintptr, (len(sd)+psize-1)/psize)
	copy(unsafe.Slice((*byte)(unsafe.Pointer(&buf[0])), len(sd)), sd)
	return (*windows.SECURITY_DESCRIPTOR)(unsafe.Pointer(&buf[0]))
}

// preparedSD is a validated descriptor ready to set on a handle: the
// SECURITY_INFORMATION mask its components need, the handle access that
// mask requires, and a pointer-aligned copy of the bytes.
type preparedSD struct {
	info   uint32
	access uint32
	desc   *windows.SECURITY_DESCRIPTOR
}

// prepareSecurity validates a captured self-relative descriptor. The
// SECURITY_INFORMATION mask comes from the descriptor itself
// (securityInfoForSD, sdtable.go); the bytes are then checked with
// RtlValidRelativeSecurityDescriptor against their real length — a manifest
// is stored remotely, and a descriptor whose internal offsets point past its
// buffer must be refused rather than handed to the kernel.
//
// access is only the rights the carried components need (WRITE_DAC for the
// DACL, WRITE_OWNER for owner/group, ACCESS_SYSTEM_SECURITY for the SACL): a
// DACL-only apply must not fail for lack of WRITE_OWNER.
func prepareSecurity(sd []byte) (preparedSD, error) {
	info, err := securityInfoForSD(sd, hasSecurityPrivilege.Load())
	if err != nil {
		return preparedSD{}, err
	}
	desc := alignedSD(sd)
	if ok, _, _ := procRtlValidRelativeSecurityDescriptor.Call(uintptr(unsafe.Pointer(desc)), uintptr(len(sd)), uintptr(info)); ok&0xff == 0 {
		return preparedSD{}, fmt.Errorf("security descriptor is not a valid self-relative descriptor of %d bytes", len(sd))
	}
	var access uint32
	if info&daclSecurityInformation != 0 {
		access |= windows.WRITE_DAC
	}
	if info&(ownerSecurityInformation|groupSecurityInformation) != 0 {
		access |= windows.WRITE_OWNER
	}
	if info&saclSecurityInformation != 0 {
		access |= windows.ACCESS_SYSTEM_SECURITY
	}
	return preparedSD{info: info, access: access, desc: desc}, nil
}

// applyToHandle sets the descriptor on an already-open handle carrying
// p.access. This is the one place a descriptor reaches the kernel; both
// applySecurity and the restore's securefs applier go through it. Setting an
// arbitrary owner (TrustedInstaller, another user) needs SeRestorePrivilege —
// the restore holds it for its duration via enableRestoreSDPrivileges.
func (p preparedSD) applyToHandle(h windows.Handle) error {
	if err := windows.SetKernelObjectSecurity(h, windows.SECURITY_INFORMATION(p.info), p.desc); err != nil {
		return fmt.Errorf("SetKernelObjectSecurity: %w", err)
	}
	return nil
}

// securityApplier returns the securefs hook that sets sd on the handle
// securefs has pinned: the restore's temporary before publication, or a
// directory reached by the no-follow walk (SEC-121 — the restore never
// reopens a published entry by pathname). nil, nil for an empty sd.
func securityApplier(sd []byte) (*securefs.SecurityApplier, error) {
	if len(sd) == 0 {
		return nil, nil
	}
	p, err := prepareSecurity(sd)
	if err != nil {
		return nil, err
	}
	return &securefs.SecurityApplier{
		Access: p.access,
		Apply:  func(h uintptr) error { return p.applyToHandle(windows.Handle(h)) },
	}, nil
}

// applySecurity reapplies a captured self-relative security descriptor to
// path through a no-follow handle (openNoFollow). A nil/empty sd is a no-op
// success. The restore does NOT use this — it applies through securefs's
// pinned handles (securityApplier); this path-based form serves callers that
// hold no pinned handle, and carries openNoFollow's final-component-only
// residual risk.
func applySecurity(path string, sd []byte) error {
	if len(sd) == 0 {
		return nil
	}
	p, err := prepareSecurity(sd)
	if err != nil {
		return fmt.Errorf("%q: %w", path, err)
	}
	h, err := openNoFollow(path, p.access)
	if err != nil {
		return fmt.Errorf("open %q to apply security: %w", path, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if err := p.applyToHandle(h); err != nil {
		return fmt.Errorf("%q: %w", path, err)
	}
	return nil
}
