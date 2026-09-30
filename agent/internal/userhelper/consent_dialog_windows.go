//go:build windows

package userhelper

import (
	"syscall"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/ipc"
)

var procMessageBoxTimeoutW = pamDialogUser32.NewProc("MessageBoxTimeoutW")

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
func showConsentDialogOS(req ipc.ConsentRequest, presented func()) dialogOutcome {
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
