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

	consentIDYes     = 6
	consentIDNo      = 7
	consentIDTimeout = 32000 // MessageBoxTimeoutW's timeout return value

	consentInfiniteMs = 0xFFFFFFFF
)

// showConsentDialogOS renders a native Yes/No prompt via MessageBoxTimeoutW
// (undocumented-but-stable user32 export; used because MessageBoxW has no
// countdown). Yes=Allow, No=Deny; the timeout return maps to answered=false
// and consentDecision applies the onTimeout policy — mirroring the Tauri
// dialog's auto-decide countdown.
func showConsentDialogOS(req ipc.ConsentRequest) (allow bool, answered bool) {
	titleStr, bodyStr := buildConsentDialogText(req)
	bodyStr += "\r\n\r\nSelect Yes to allow, or No to decline."
	title, err := syscall.UTF16PtrFromString(titleStr)
	if err != nil {
		return false, true // treat as an explicit deny; never crash the helper on bad input
	}
	body, err := syscall.UTF16PtrFromString(bodyStr)
	if err != nil {
		return false, true
	}
	timeoutMs := uintptr(consentInfiniteMs)
	if req.TimeoutMs > 0 {
		timeoutMs = uintptr(req.TimeoutMs)
	}
	flags := uintptr(consentMBYesNo | consentMBIconQuestion | consentMBTopMost | consentMBSystemModal | consentMBSetForeground)
	ret, _, _ := procMessageBoxTimeoutW.Call(
		0,
		uintptr(unsafe.Pointer(body)),
		uintptr(unsafe.Pointer(title)),
		flags,
		0, // language id
		timeoutMs,
	)
	switch ret {
	case consentIDYes:
		return true, true
	case consentIDTimeout:
		return false, false
	default: // IDNO, dialog dismissed, or call failure (ret 0)
		return false, true
	}
}
