//go:build windows

package pamactuator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	winFindWindowEx             = winUser32.NewProc("FindWindowExW")
	winGetWindowThreadProcessId = winUser32.NewProc("GetWindowThreadProcessId")
	winGetForegroundWindow      = winUser32.NewProc("GetForegroundWindow")
	winSetForegroundWindow      = winUser32.NewProc("SetForegroundWindow")
	consentPromptWindowClasses  = []string{"$$$Secure UAP Background Window$$$", "Credential Dialog Xaml Host"}
	maxConsentWindowsPerClass   = 64
)

// DismissInstance cancels exactly one consent.exe prompt (#8995). It attaches
// to the input desktop like Dismiss, then runs the guarded sequence in
// dismissConsentInstance: verify the PID + creation time still name a live
// consent.exe in this session, find a prompt window that process owns, require
// it to be (or become) the foreground window, and only then press Escape.
// tokenLaunchActuator inherits this through its embedded windowsActuator.
func (a *windowsActuator) DismissInstance(ctx context.Context, inst ConsentInstance) Result {
	if result, cancelled := dismissCancellationResult(ctx); cancelled {
		return result
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hDesk, _, openErr := winProcOpenInputDesktop.Call(0, 0, uintptr(winDesktopGenericAll))
	if hDesk == 0 {
		slog.Warn("pamactuator: OpenInputDesktop failed (targeted dismiss)", "error", openErr.Error())
		return Result{Success: false, Reason: "desktop_open_failed",
			DetailMessage: "OpenInputDesktop returned 0: " + openErr.Error()}
	}
	defer func() { _, _, _ = winProcCloseDesktop.Call(hDesk) }()

	if ret, _, setErr := winProcSetThreadDesktop.Call(hDesk); ret == 0 {
		slog.Warn("pamactuator: SetThreadDesktop failed (targeted dismiss)", "error", setErr.Error())
		return Result{Success: false, Reason: "set_thread_desktop_failed",
			DetailMessage: "SetThreadDesktop returned 0: " + setErr.Error()}
	}

	deadline := time.Now().Add(defaultConsentTimeoutMs * time.Millisecond)
	return dismissConsentInstance(ctx, winConsentInstanceOps{}, inst, deadline, pollInterval)
}

type winConsentInstanceOps struct{}

// InstanceLive reads the process now holding inst.PID and lets the
// platform-neutral consentProcessMatches decide whether it is still the
// recorded prompt.
func (winConsentInstanceOps) InstanceLive(inst ConsentInstance) (bool, error) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, inst.PID)
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return false, nil // no process with this PID any more
		}
		return false, fmt.Errorf("OpenProcess(%d): %w", inst.PID, err)
	}
	defer func() { _ = windows.CloseHandle(process) }()

	var facts consentProcessFacts
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &creation, &exit, &kernel, &user); err != nil {
		return false, fmt.Errorf("GetProcessTimes(%d): %w", inst.PID, err)
	}
	// Same conversion etwlua uses when it records the instance.
	facts.CreatedAt = time.Unix(0, creation.Nanoseconds())
	if err := windows.GetExitCodeProcess(process, &facts.ExitCode); err != nil {
		return false, fmt.Errorf("GetExitCodeProcess(%d): %w", inst.PID, err)
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(process, 0, &buf[0], &size); err != nil {
		return false, fmt.Errorf("QueryFullProcessImageName(%d): %w", inst.PID, err)
	}
	facts.ImagePath = windows.UTF16ToString(buf[:size])
	if err := windows.ProcessIdToSessionId(inst.PID, &facts.Session); err != nil {
		return false, fmt.Errorf("ProcessIdToSessionId(%d): %w", inst.PID, err)
	}
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &facts.HelperSession); err != nil {
		return false, fmt.Errorf("ProcessIdToSessionId(self): %w", err)
	}
	return consentProcessMatches(inst, facts)
}

func (winConsentInstanceOps) FindInstanceWindow(pid uint32) uintptr {
	for _, class := range consentPromptWindowClasses {
		classPtr, err := syscall.UTF16PtrFromString(class)
		if err != nil {
			continue
		}
		var after uintptr
		for i := 0; i < maxConsentWindowsPerClass; i++ {
			hwnd, _, _ := winFindWindowEx.Call(0, after, uintptr(unsafe.Pointer(classPtr)), 0)
			if hwnd == 0 {
				break
			}
			if windowOwnerPID(hwnd) == pid {
				return hwnd
			}
			after = hwnd
		}
	}
	return 0
}

func (winConsentInstanceOps) ForegroundOwnedBy(pid uint32) bool {
	hwnd, _, _ := winGetForegroundWindow.Call()
	return hwnd != 0 && windowOwnerPID(hwnd) == pid
}

func (winConsentInstanceOps) BringToForeground(hwnd uintptr) {
	_, _, _ = winSetForegroundWindow.Call(hwnd)
}

func (winConsentInstanceOps) PressEscape() error { return pressVK(vkEscape) }

func (winConsentInstanceOps) WindowAlive(hwnd uintptr) bool { return isWindowAlive(hwnd) }

func windowOwnerPID(hwnd uintptr) uint32 {
	var pid uint32
	_, _, _ = winGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid
}

var (
	_ InstanceDismisser = (*windowsActuator)(nil)
	_ InstanceDismisser = (*tokenLaunchActuator)(nil)
)
