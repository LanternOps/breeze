//go:build windows

package userhelper

import (
	"context"
	"os"
	"syscall"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/ipc"
)

var (
	procMessageBoxTimeoutW       = pamDialogUser32.NewProc("MessageBoxTimeoutW")
	procFindWindowExW            = pamDialogUser32.NewProc("FindWindowExW")
	procGetWindowThreadProcessId = pamDialogUser32.NewProc("GetWindowThreadProcessId")
)

const (
	consentWMCommand          = 0x0111
	consentDialogPollInterval = 200 * time.Millisecond
)

const (
	consentMBYesNo         = 0x00000004
	consentMBIconQuestion  = 0x00000020
	consentMBSystemModal   = 0x00001000
	consentMBSetForeground = 0x00010000
	consentMBTopMost       = 0x00040000

	consentInfiniteMs = 0xFFFFFFFF
)

// showConsentDialogOS renders a native Yes/No prompt via MessageBoxTimeoutW
// (undocumented-but-stable user32 export; used because MessageBoxW has no
// countdown). Yes=Allow, No=Deny; the box's own timeout return is reported
// as an expired countdown, and a failed call as unavailable — never as a
// user decision (classifyMessageBoxReturn).
func showConsentDialogOS(ctx context.Context, req ipc.ConsentRequest, presented func()) dialogOutcome {
	titleStr, bodyStr := buildConsentDialogText(req)
	bodyStr += "\r\n\r\nSelect Yes to allow, or No to decline."
	title, err := syscall.UTF16PtrFromString(titleStr)
	if err != nil {
		return dialogUnavailable
	}
	body, err := syscall.UTF16PtrFromString(bodyStr)
	if err != nil {
		return dialogUnavailable
	}
	timeoutMs := uintptr(consentInfiniteMs)
	if req.TimeoutMs > 0 {
		timeoutMs = uintptr(req.TimeoutMs)
	}
	flags := uintptr(consentMBYesNo | consentMBIconQuestion | consentMBTopMost | consentMBSystemModal | consentMBSetForeground)
	presented()
	done := make(chan struct{})
	defer close(done)
	go closeConsentBoxOnCancel(ctx, done, title)
	ret, _, _ := procMessageBoxTimeoutW.Call(
		0,
		uintptr(unsafe.Pointer(body)),
		uintptr(unsafe.Pointer(title)),
		flags,
		0, // language id
		timeoutMs,
	)
	return classifyMessageBoxReturn(ret)
}

// closeConsentBoxOnCancel presses No on this process's consent message box
// when ctx is cancelled (the agent withdrew the prompt), so it does not stay
// on screen until its countdown ends. The box is found by its dialog class
// and title and must belong to this process.
func closeConsentBoxOnCancel(ctx context.Context, done <-chan struct{}, title *uint16) {
	select {
	case <-done:
		return
	case <-ctx.Done():
	}
	dialogClass, _ := syscall.UTF16PtrFromString("#32770")
	self := uint32(os.Getpid())
	for {
		var hwnd uintptr
		for {
			hwnd, _, _ = procFindWindowExW.Call(0, hwnd, uintptr(unsafe.Pointer(dialogClass)), uintptr(unsafe.Pointer(title)))
			if hwnd == 0 {
				break
			}
			var pid uint32
			_, _, _ = procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
			if pid == self {
				_, _, _ = procPostMessageW.Call(hwnd, consentWMCommand, consentIDNo, 0)
			}
		}
		select {
		case <-done:
			return
		case <-time.After(consentDialogPollInterval):
		}
	}
}
