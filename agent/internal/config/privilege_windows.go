//go:build windows

package config

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// errRestorePrivilegeNotHeld reports that the process token does not hold
// SeRestorePrivilege at all (a standard user, or an administrator running
// with the UAC-filtered token), as opposed to holding it disabled.
var errRestorePrivilegeNotHeld = errors.New("SeRestorePrivilege is not held by the process token")

var procConfigAdjustTokenPrivileges = windows.NewLazySystemDLL("advapi32.dll").NewProc("AdjustTokenPrivileges")

// restorePrivilegeMu serialises the enable → SetNamedSecurityInfo → disable
// window. Privilege state lives on the process token, so without it one
// caller's release could switch the privilege off while another caller's
// owner write is still relying on it.
var restorePrivilegeMu sync.Mutex

// enableRestorePrivilege enables SeRestorePrivilege on this process's token so
// the next SetNamedSecurityInfo may assign an owner other than the caller's own
// user or an SE_GROUP_OWNER group (here: LocalSystem). An elevated local
// administrator holds the privilege but has it disabled by default; SYSTEM
// never needs it for its own SID and never reaches this (see
// assignOwnerWithFallback).
//
// release restores the privilege to its previous state and must be called as
// soon as the owner write is done. The same pattern, with reference counting
// for long-lived scopes, is internal/backup/winpriv_windows.go. That package is
// not imported here because it depends on this one; the only caller here is
// the one-shot owner write, which the mutex below already makes exclusive.
func enableRestorePrivilege() (release func(), err error) {
	restorePrivilegeMu.Lock()
	wasEnabled, err := setRestorePrivilege(true)
	if err != nil {
		restorePrivilegeMu.Unlock()
		return nil, err
	}
	return sync.OnceFunc(func() {
		defer restorePrivilegeMu.Unlock()
		if wasEnabled {
			return
		}
		if _, err := setRestorePrivilege(false); err != nil {
			log.Warn("failed to disable SeRestorePrivilege after assigning a directory owner", "error", err.Error())
		}
	}), nil
}

// setRestorePrivilege enables or disables SeRestorePrivilege and reports
// whether it was enabled beforehand. AdjustTokenPrivileges goes through the
// raw proc because x/sys's wrapper drops GetLastError on success, and
// ERROR_NOT_ALL_ASSIGNED (privilege not held) is reported exactly that way.
func setRestorePrivilege(enable bool) (wasEnabled bool, err error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		return false, fmt.Errorf("open process token: %w", err)
	}
	defer func() { _ = token.Close() }()

	name, err := windows.UTF16PtrFromString("SeRestorePrivilege")
	if err != nil {
		return false, err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, name, &luid); err != nil {
		return false, fmt.Errorf("lookup SeRestorePrivilege: %w", err)
	}
	var attrs uint32
	if enable {
		attrs = windows.SE_PRIVILEGE_ENABLED
	}
	newState := windows.Tokenprivileges{
		PrivilegeCount: 1,
		Privileges:     [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: attrs}},
	}
	var prev windows.Tokenprivileges
	var retLen uint32
	r1, _, callErr := procConfigAdjustTokenPrivileges.Call(
		uintptr(token), 0, uintptr(unsafe.Pointer(&newState)),
		unsafe.Sizeof(prev), uintptr(unsafe.Pointer(&prev)), uintptr(unsafe.Pointer(&retLen)),
	)
	if r1 == 0 {
		return false, fmt.Errorf("adjust token privileges for SeRestorePrivilege: %w", callErr)
	}
	if errors.Is(callErr, windows.ERROR_NOT_ALL_ASSIGNED) {
		return false, errRestorePrivilegeNotHeld
	}
	// PreviousState lists only privileges whose state changed; an empty list
	// means it was already in the requested state.
	if prev.PrivilegeCount == 0 {
		return enable, nil
	}
	return prev.Privileges[0].Attributes&windows.SE_PRIVILEGE_ENABLED != 0, nil
}
