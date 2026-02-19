//go:build windows

package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	sasDLL  *syscall.LazyDLL
	sendSAS *syscall.LazyProc

	modAdvapi32               = windows.NewLazySystemDLL("advapi32.dll")
	procAdjustTokenPrivileges = modAdvapi32.NewProc("AdjustTokenPrivileges")
)

func init() {
	sasDLL = syscall.NewLazyDLL("sas.dll")
	sendSAS = sasDLL.NewProc("SendSAS")
}

// enableTcbPrivilege enables SE_TCB_PRIVILEGE on the current process token.
// This privilege is typically held only by the LocalSystem account and is
// required for SendSAS(TRUE) (application mode).
func enableTcbPrivilege() error {
	var token windows.Token
	proc := windows.CurrentProcess()
	err := windows.OpenProcessToken(proc, windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token)
	if err != nil {
		return fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer token.Close()

	var luid windows.LUID
	tcbName, _ := windows.UTF16PtrFromString("SeTcbPrivilege")
	err = windows.LookupPrivilegeValue(nil, tcbName, &luid)
	if err != nil {
		return fmt.Errorf("LookupPrivilegeValue(SeTcbPrivilege): %w", err)
	}

	type tokenPrivileges struct {
		PrivilegeCount uint32
		Privileges     [1]windows.LUIDAndAttributes
	}

	tp := tokenPrivileges{
		PrivilegeCount: 1,
		Privileges: [1]windows.LUIDAndAttributes{
			{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED},
		},
	}

	ret, _, lastErr := procAdjustTokenPrivileges.Call(
		uintptr(token),
		0,
		uintptr(unsafe.Pointer(&tp)),
		0, 0, 0,
	)
	if ret == 0 {
		return fmt.Errorf("AdjustTokenPrivileges: %w", lastErr)
	}
	if errno, ok := lastErr.(syscall.Errno); ok && errno == syscall.Errno(windows.ERROR_NOT_ALL_ASSIGNED) {
		return fmt.Errorf("SE_TCB_PRIVILEGE not held by this token")
	}
	return nil
}

// getProcessSessionID returns the Windows session ID for the current process.
func getProcessSessionID() (uint32, error) {
	pid := windows.GetCurrentProcessId()
	var sessionID uint32
	err := windows.ProcessIdToSessionId(pid, &sessionID)
	if err != nil {
		return 0, err
	}
	return sessionID, nil
}

func loadSendSAS() error {
	if err := sasDLL.Load(); err != nil {
		return fmt.Errorf("sas.dll not available: %w", err)
	}
	if err := sendSAS.Find(); err != nil {
		return fmt.Errorf("SendSAS proc not found: %w", err)
	}
	return nil
}

// callSendSAS invokes SendSAS from sas.dll.
// SendSAS is a VOID API, so invocation success can only mean the call was
// issued; policy/context may still cause Windows to ignore it.
func callSendSAS(asUser bool) error {
	if err := loadSendSAS(); err != nil {
		return err
	}
	mode := uintptr(0)
	if asUser {
		mode = 1
	}
	sendSAS.Call(mode)
	slog.Info("SendSAS called", "asUser", asUser)
	return nil
}

// InvokeSAS triggers the Secure Attention Sequence (Ctrl+Alt+Del).
// Uses policy-aware SendSAS attempts — tries the service path first (most
// reliable from an SCM-registered process), then falls back to the application
// path only if the service path failed. Returns early after the first success
// to avoid sending duplicate SAS events.
func InvokeSAS() error {
	// Pin to OS thread for desktop-sensitive operations
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Log diagnostic info
	sessionID, sessErr := getProcessSessionID()
	if sessErr != nil {
		slog.Warn("InvokeSAS: failed to determine session ID", "error", sessErr.Error())
	} else {
		slog.Info("InvokeSAS diagnostics", "sessionId", sessionID)
	}

	policy := CheckSASPolicy()
	var errs []error

	// Try service path first (SendSAS(FALSE)) — most reliable from SCM process
	if policy.AllowsServices() {
		if err := callSendSAS(false); err != nil {
			errs = append(errs, fmt.Errorf("SendSAS(FALSE): %w", err))
		} else {
			slog.Info("SAS invocation attempted", "path", "service", "policy", int(policy))
			return nil
		}
	} else {
		errs = append(errs, fmt.Errorf("SoftwareSASGeneration policy (%d) does not allow service SAS", policy))
	}

	// Fallback: application path (SendSAS(TRUE)) — requires SeTcbPrivilege
	if policy.AllowsApps() {
		if err := enableTcbPrivilege(); err != nil {
			errs = append(errs, fmt.Errorf("enable SeTcbPrivilege: %w", err))
		} else if err := callSendSAS(true); err != nil {
			errs = append(errs, fmt.Errorf("SendSAS(TRUE): %w", err))
		} else {
			if len(errs) > 0 {
				slog.Warn("SAS service path failed, application path succeeded", "serviceErrors", errors.Join(errs...).Error())
			}
			slog.Info("SAS invocation attempted", "path", "application", "policy", int(policy))
			return nil
		}
	}

	return errors.Join(errs...)
}

// SASPolicyStatus represents the SoftwareSASGeneration registry value.
type SASPolicyStatus int

const (
	SASPolicyDisabled     SASPolicyStatus = 0 // SAS generation disabled (default)
	SASPolicyServices     SASPolicyStatus = 1 // Only services can generate SAS
	SASPolicyApps         SASPolicyStatus = 2 // Only applications with SeTcbPrivilege can generate SAS
	SASPolicyServicesApps SASPolicyStatus = 3 // Both services and applications can generate SAS
)

// AllowsServices reports whether the policy permits service-mode SAS (SendSAS(FALSE)).
func (p SASPolicyStatus) AllowsServices() bool {
	return p == SASPolicyServices || p == SASPolicyServicesApps
}

// AllowsApps reports whether the policy permits application-mode SAS (SendSAS(TRUE)).
func (p SASPolicyStatus) AllowsApps() bool {
	return p == SASPolicyApps || p == SASPolicyServicesApps
}

const sasRegistryPath = `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`
const sasRegistryKey = "SoftwareSASGeneration"

// CheckSASPolicy reads the SoftwareSASGeneration registry value to determine
// if software-generated SAS is allowed and in which mode.
func CheckSASPolicy() SASPolicyStatus {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, sasRegistryPath, registry.QUERY_VALUE)
	if err != nil {
		// Key doesn't exist — SAS generation is disabled (default)
		return SASPolicyDisabled
	}
	defer k.Close()

	val, _, err := k.GetIntegerValue(sasRegistryKey)
	if err != nil {
		return SASPolicyDisabled
	}
	if val > 3 {
		slog.Warn("unexpected SoftwareSASGeneration registry value, treating as disabled", "value", val)
		return SASPolicyDisabled
	}
	return SASPolicyStatus(val)
}

var procLockWorkStation = user32.NewProc("LockWorkStation")

// LockWorkstation calls the Win32 LockWorkStation API to lock the desktop.
// Unlike Win+L via SendInput (which the OS intercepts at the keyboard driver
// level before it reaches the application queue), the API call works from any
// context including services and SYSTEM processes.
func LockWorkstation() error {
	ret, _, err := procLockWorkStation.Call()
	if ret == 0 {
		return fmt.Errorf("LockWorkStation: %w", err)
	}
	slog.Info("LockWorkStation called")
	return nil
}

// SetSASPolicy writes the SoftwareSASGeneration registry value.
// Requires SYSTEM or admin privileges.
func SetSASPolicy(value uint32) error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, sasRegistryPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("failed to open registry key for writing: %w", err)
	}
	defer k.Close()

	if err := k.SetDWordValue(sasRegistryKey, value); err != nil {
		return fmt.Errorf("failed to set %s to %d: %w", sasRegistryKey, value, err)
	}
	return nil
}
