//go:build windows

package backup

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
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
// or symlink swapped into an INTERMEDIATE component between publication and
// this open would still redirect it. Restore targets live under a tree the
// restore itself just created and owns, so that window is accepted here.
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

// applySecurity reapplies a captured self-relative security descriptor to
// path. A nil/empty sd is a no-op success (nothing to apply — matches the
// SDIndex==0 "unknown" convention). The SECURITY_INFORMATION mask comes
// from the descriptor itself (securityInfoForSD, sdtable.go).
//
// It never touches the published pathname through a path-based setter
// (SetFileSecurityW would follow a reparse point swapped in after
// publication): the target is opened no-follow (openNoFollow) for exactly
// WRITE_DAC|WRITE_OWNER (+ACCESS_SYSTEM_SECURITY when the SACL is applied)
// and the descriptor is set on that handle with SetKernelObjectSecurity.
// Setting an arbitrary owner (TrustedInstaller, another user) needs
// SeRestorePrivilege — the restore holds it for its duration via
// enableRestoreSDPrivileges.
//
// The bytes are validated with RtlValidRelativeSecurityDescriptor against
// their real length first: a manifest is stored remotely, and a descriptor
// whose internal offsets point past its buffer must be refused rather than
// handed to the kernel.
func applySecurity(path string, sd []byte) error {
	if len(sd) == 0 {
		return nil
	}
	info, err := securityInfoForSD(sd, hasSecurityPrivilege.Load())
	if err != nil {
		return err
	}
	desc := alignedSD(sd)
	if ok, _, _ := procRtlValidRelativeSecurityDescriptor.Call(uintptr(unsafe.Pointer(desc)), uintptr(len(sd)), uintptr(info)); ok&0xff == 0 {
		return fmt.Errorf("security descriptor for %q is not a valid self-relative descriptor of %d bytes", path, len(sd))
	}
	access := uint32(windows.WRITE_DAC | windows.WRITE_OWNER)
	if info&saclSecurityInformation != 0 {
		access |= windows.ACCESS_SYSTEM_SECURITY
	}
	h, err := openNoFollow(path, access)
	if err != nil {
		return fmt.Errorf("open %q to apply security: %w", path, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if err := windows.SetKernelObjectSecurity(h, windows.SECURITY_INFORMATION(info), desc); err != nil {
		return fmt.Errorf("SetKernelObjectSecurity on %q: %w", path, err)
	}
	return nil
}
