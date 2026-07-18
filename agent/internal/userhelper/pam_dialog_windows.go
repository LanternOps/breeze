//go:build windows

package userhelper

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/ipc"
)

var (
	pamDialogUser32   = syscall.NewLazyDLL("user32.dll")
	pamDialogKernel32 = syscall.NewLazyDLL("kernel32.dll")

	procMessageBoxW                  = pamDialogUser32.NewProc("MessageBoxW")
	procPamOpenInputDesktop          = pamDialogUser32.NewProc("OpenInputDesktop")
	procPamGetThreadDesktop          = pamDialogUser32.NewProc("GetThreadDesktop")
	procPamSetThreadDesktop          = pamDialogUser32.NewProc("SetThreadDesktop")
	procPamCloseDesktop              = pamDialogUser32.NewProc("CloseDesktop")
	procPamGetUserObjectInformationW = pamDialogUser32.NewProc("GetUserObjectInformationW")
	procPamGetCurrentThreadID        = pamDialogKernel32.NewProc("GetCurrentThreadId")
)

const (
	mbYesNo         = 0x00000004
	mbIconWarning   = 0x00000030
	mbSystemModal   = 0x00001000
	mbSetForeground = 0x00010000
	mbTopMost       = 0x00040000

	idYes = 6

	pamDesktopGenericAll = 0x10000000
	pamUOIName           = 2

	// pamDialogTitle is the window/dialog caption for the elevation prompt.
	// Defined here (windows-only) because only the Win32 dialog and MessageBox
	// renderings use it; the cross-platform content helpers do not.
	pamDialogTitle = "Breeze — Elevation Request"
)

func showPamDialog(req ipc.PamRequestDialog) ipc.PamDialogResult {
	return showPamDialogOnInputDesktop(windowsPamDesktopOps{}, func(_ string) ipc.PamDialogResult {
		// The custom window is the primary rendering; the plain MessageBox
		// stays as a fallback so a class-registration or window-creation
		// failure can never swallow an elevation prompt.
		if result, ok := showPamDialogWindow(req); ok {
			return result
		}
		log.Warn("pam: custom elevation dialog unavailable; falling back to MessageBox")
		return showPamMessageBox(req)
	})
}

func showPamMessageBox(req ipc.PamRequestDialog) ipc.PamDialogResult {
	title := syscall.StringToUTF16Ptr(pamDialogTitle)
	body := syscall.StringToUTF16Ptr(buildPamDialogBody(req))
	flags := uintptr(mbYesNo | mbIconWarning | mbTopMost | mbSystemModal | mbSetForeground)

	ret, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), flags)
	if ret == idYes {
		return ipc.PamDialogResult{Approved: true}
	}
	return ipc.PamDialogResult{Approved: false, DismissedByUser: true}
}

type windowsPamDesktopOps struct{}

func (windowsPamDesktopOps) LockOSThread()   { runtime.LockOSThread() }
func (windowsPamDesktopOps) UnlockOSThread() { runtime.UnlockOSThread() }

func (windowsPamDesktopOps) CurrentThreadDesktop() (uintptr, error) {
	threadID, _, _ := procPamGetCurrentThreadID.Call()
	handle, _, callErr := procPamGetThreadDesktop.Call(threadID)
	if handle == 0 {
		return 0, fmt.Errorf("GetThreadDesktop: %w", callErr)
	}
	return handle, nil
}

func (windowsPamDesktopOps) OpenInputDesktop() (uintptr, error) {
	handle, _, callErr := procPamOpenInputDesktop.Call(0, 0, uintptr(pamDesktopGenericAll))
	if handle == 0 {
		return 0, fmt.Errorf("OpenInputDesktop: %w", callErr)
	}
	return handle, nil
}

func (windowsPamDesktopOps) DesktopName(handle uintptr) (string, error) {
	var buffer [128]uint16
	var needed uint32
	ret, _, callErr := procPamGetUserObjectInformationW.Call(
		handle,
		pamUOIName,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)*2),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ret == 0 {
		return "", fmt.Errorf("GetUserObjectInformationW(UOI_NAME): %w", callErr)
	}

	length := int(needed / 2)
	if length > len(buffer) {
		length = len(buffer)
	}
	for i := 0; i < length; i++ {
		if buffer[i] == 0 {
			length = i
			break
		}
	}
	name := syscall.UTF16ToString(buffer[:length])
	if name == "" {
		return "", fmt.Errorf("GetUserObjectInformationW(UOI_NAME) returned an empty name")
	}
	return name, nil
}

func (windowsPamDesktopOps) SetThreadDesktop(handle uintptr) error {
	ret, _, callErr := procPamSetThreadDesktop.Call(handle)
	if ret == 0 {
		return fmt.Errorf("SetThreadDesktop: %w", callErr)
	}
	return nil
}

func (windowsPamDesktopOps) CloseDesktop(handle uintptr) error {
	ret, _, callErr := procPamCloseDesktop.Call(handle)
	if ret == 0 {
		return fmt.Errorf("CloseDesktop: %w", callErr)
	}
	return nil
}

