//go:build windows

package pamactuator

import (
	"fmt"
	"syscall"
	"unsafe"
)

// Local Windows input primitives. Intentionally duplicated from
// remote/desktop/input_windows.go rather than refactored into a shared
// package — see Q5 of the Track 5 firmup. The actuator only needs
// SendInput with KEYEVENTF_UNICODE for typing characters plus a handful
// of VK codes for Tab/Enter, and pulling in remote/desktop would drag
// the entire WebRTC capture stack into the agent service path.

var (
	winUser32     = syscall.NewLazyDLL("user32.dll")
	winSendInput  = winUser32.NewProc("SendInput")
	winMapVKey    = winUser32.NewProc("MapVirtualKeyW")
	winFindWindow = winUser32.NewProc("FindWindowW")
	winIsWindow   = winUser32.NewProc("IsWindow")
)

const (
	inputKeyboard = 1

	keyeventfKeyUp    = 0x0002
	keyeventfUnicode  = 0x0004
	mapvkVKtoVSC      = 0
)

const (
	vkTab    = 0x09
	vkReturn = 0x0D
)

// keybdInput mirrors the Win32 KEYBDINPUT struct. Layout matches the
// 32-byte INPUT union on x64 (4-byte type + 4-byte pad + 24-byte member).
type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type winInput struct {
	inputType uint32
	_         [4]byte // padding so the union starts at offset 8 on x64
	ki        keybdInput
	_         [8]byte // pad union to MOUSEINPUT size (24 bytes on x64)
}

// vkToScan resolves the hardware scan code for a virtual-key. Some apps
// (consent.exe included, empirically) require wScan to be populated.
func vkToScan(vk uint16) uint16 {
	sc, _, _ := winMapVKey.Call(uintptr(vk), mapvkVKtoVSC)
	return uint16(sc)
}

// sendOne dispatches a single INPUT struct via SendInput. Returns the
// raw cReturned count (1 on success, 0 on failure).
func sendOne(in *winInput) (uint32, error) {
	ret, _, callErr := winSendInput.Call(
		1,
		uintptr(unsafe.Pointer(in)),
		unsafe.Sizeof(*in),
	)
	if ret == 0 {
		return 0, fmt.Errorf("SendInput returned 0: %v", callErr)
	}
	return uint32(ret), nil
}

// typeRune injects a single Unicode codepoint via KEYEVENTF_UNICODE.
// Used for username/password characters; bypasses keyboard layout and
// works for any printable Unicode value the OS accepts.
func typeRune(r rune) error {
	down := winInput{inputType: inputKeyboard}
	down.ki.wVk = 0
	down.ki.wScan = uint16(r)
	down.ki.dwFlags = keyeventfUnicode
	if _, err := sendOne(&down); err != nil {
		return fmt.Errorf("KEYEVENTF_UNICODE down: %w", err)
	}

	up := winInput{inputType: inputKeyboard}
	up.ki.wVk = 0
	up.ki.wScan = uint16(r)
	up.ki.dwFlags = keyeventfUnicode | keyeventfKeyUp
	if _, err := sendOne(&up); err != nil {
		return fmt.Errorf("KEYEVENTF_UNICODE up: %w", err)
	}
	return nil
}

// pressVK sends a vk-down then vk-up pair. Used for Tab/Enter only; user
// content goes through typeRune so layout-independent Unicode is used.
func pressVK(vk uint16) error {
	down := winInput{inputType: inputKeyboard}
	down.ki.wVk = vk
	down.ki.wScan = vkToScan(vk)
	if _, err := sendOne(&down); err != nil {
		return fmt.Errorf("vk %#x down: %w", vk, err)
	}

	up := winInput{inputType: inputKeyboard}
	up.ki.wVk = vk
	up.ki.wScan = vkToScan(vk)
	up.ki.dwFlags = keyeventfKeyUp
	if _, err := sendOne(&up); err != nil {
		return fmt.Errorf("vk %#x up: %w", vk, err)
	}
	return nil
}

// findConsentWindow looks for the topmost consent.exe window via
// FindWindowW("Consent.exe Frame Window", nil) — the well-known class
// name registered by consent.exe since Vista. Returns 0 if no window
// is present.
func findConsentWindow() uintptr {
	classNamePtr, err := syscall.UTF16PtrFromString("$$$Secure UAP Background Window$$$")
	if err != nil {
		return 0
	}
	hwnd, _, _ := winFindWindow.Call(uintptr(unsafe.Pointer(classNamePtr)), 0)
	if hwnd != 0 {
		return hwnd
	}
	// Fallback: the wrapper class used on Win10+. Different builds vary,
	// so a second probe avoids missing the prompt on newer servicing
	// channels. If both miss, the caller will retry after a sleep.
	classNamePtr2, err := syscall.UTF16PtrFromString("Credential Dialog Xaml Host")
	if err != nil {
		return 0
	}
	hwnd2, _, _ := winFindWindow.Call(uintptr(unsafe.Pointer(classNamePtr2)), 0)
	return hwnd2
}

// isWindowAlive reports whether the given HWND still refers to a real
// window. Used to detect consent.exe closing after credential submit.
func isWindowAlive(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	ret, _, _ := winIsWindow.Call(hwnd)
	return ret != 0
}
