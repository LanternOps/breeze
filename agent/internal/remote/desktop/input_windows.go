//go:build windows

package desktop

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

var (
	user32         = syscall.NewLazyDLL("user32.dll")
	sendInput      = user32.NewProc("SendInput")
	setcursorpos   = user32.NewProc("SetCursorPos")
	mapvirtualkey  = user32.NewProc("MapVirtualKeyW")
)

const (
	INPUT_MOUSE    = 0
	INPUT_KEYBOARD = 1

	MOUSEEVENTF_MOVE       = 0x0001
	MOUSEEVENTF_LEFTDOWN   = 0x0002
	MOUSEEVENTF_LEFTUP     = 0x0004
	MOUSEEVENTF_RIGHTDOWN  = 0x0008
	MOUSEEVENTF_RIGHTUP    = 0x0010
	MOUSEEVENTF_MIDDLEDOWN = 0x0020
	MOUSEEVENTF_MIDDLEUP   = 0x0040
	MOUSEEVENTF_WHEEL      = 0x0800
	MOUSEEVENTF_ABSOLUTE   = 0x8000

	KEYEVENTF_KEYUP   = 0x0002
	KEYEVENTF_UNICODE = 0x0004

	VK_SHIFT   = 0x10
	VK_CONTROL = 0x11
	VK_MENU    = 0x12 // Alt
	VK_LWIN    = 0x5B
)

type mouseInput struct {
	dx, dy      int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type input struct {
	inputType uint32
	padding   [4]byte
	mi        mouseInput
}

// WindowsInputHandler handles input on Windows
type WindowsInputHandler struct{}

// NewInputHandler creates a Windows input handler
func NewInputHandler() InputHandler {
	return &WindowsInputHandler{}
}

func (h *WindowsInputHandler) SendMouseMove(x, y int) error {
	ret, _, _ := setcursorpos.Call(uintptr(x), uintptr(y))
	if ret == 0 {
		return fmt.Errorf("SetCursorPos failed")
	}
	return nil
}

func (h *WindowsInputHandler) SendMouseClick(x, y int, button string) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}
	if err := h.SendMouseDown(x, y, button); err != nil {
		return err
	}
	return h.SendMouseUp(x, y, button)
}

func (h *WindowsInputHandler) SendMouseDown(x, y int, button string) error {
	var flags uint32
	switch button {
	case "left":
		flags = MOUSEEVENTF_LEFTDOWN
	case "right":
		flags = MOUSEEVENTF_RIGHTDOWN
	case "middle":
		flags = MOUSEEVENTF_MIDDLEDOWN
	default:
		flags = MOUSEEVENTF_LEFTDOWN
	}

	inp := input{inputType: INPUT_MOUSE}
	inp.mi.dwFlags = flags

	sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	return nil
}

func (h *WindowsInputHandler) SendMouseUp(x, y int, button string) error {
	var flags uint32
	switch button {
	case "left":
		flags = MOUSEEVENTF_LEFTUP
	case "right":
		flags = MOUSEEVENTF_RIGHTUP
	case "middle":
		flags = MOUSEEVENTF_MIDDLEUP
	default:
		flags = MOUSEEVENTF_LEFTUP
	}

	inp := input{inputType: INPUT_MOUSE}
	inp.mi.dwFlags = flags

	sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	return nil
}

func (h *WindowsInputHandler) SendMouseScroll(x, y int, delta int) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}

	inp := input{inputType: INPUT_MOUSE}
	inp.mi.dwFlags = MOUSEEVENTF_WHEEL
	inp.mi.mouseData = uint32(delta * 120) // Windows uses multiples of 120

	sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	return nil
}

func (h *WindowsInputHandler) SendKeyPress(key string, modifiers []string) error {
	// Press modifiers
	for _, mod := range modifiers {
		h.sendModifierKey(mod, false)
	}

	// Press and release key
	h.SendKeyDown(key)
	h.SendKeyUp(key)

	// Release modifiers (in reverse order)
	for i := len(modifiers) - 1; i >= 0; i-- {
		h.sendModifierKey(modifiers[i], true)
	}

	return nil
}

func (h *WindowsInputHandler) sendModifierKey(mod string, up bool) {
	var vk uint16
	switch strings.ToLower(mod) {
	case "ctrl", "control":
		vk = VK_CONTROL
	case "alt":
		vk = VK_MENU
	case "shift":
		vk = VK_SHIFT
	case "meta", "win", "cmd":
		vk = VK_LWIN
	default:
		return
	}

	inp := input{inputType: INPUT_KEYBOARD}
	ki := (*keybdInput)(unsafe.Pointer(&inp.mi))
	ki.wVk = vk
	if up {
		ki.dwFlags = KEYEVENTF_KEYUP
	}

	sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
}

func (h *WindowsInputHandler) SendKeyDown(key string) error {
	vk := charToVK(key)

	inp := input{inputType: INPUT_KEYBOARD}
	ki := (*keybdInput)(unsafe.Pointer(&inp.mi))
	ki.wVk = vk

	sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	return nil
}

func (h *WindowsInputHandler) SendKeyUp(key string) error {
	vk := charToVK(key)

	inp := input{inputType: INPUT_KEYBOARD}
	ki := (*keybdInput)(unsafe.Pointer(&inp.mi))
	ki.wVk = vk
	ki.dwFlags = KEYEVENTF_KEYUP

	sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	return nil
}

func (h *WindowsInputHandler) HandleEvent(event InputEvent) error {
	switch event.Type {
	case "mouse_move":
		return h.SendMouseMove(event.X, event.Y)
	case "mouse_click":
		return h.SendMouseClick(event.X, event.Y, event.Button)
	case "mouse_down":
		return h.SendMouseDown(event.X, event.Y, event.Button)
	case "mouse_up":
		return h.SendMouseUp(event.X, event.Y, event.Button)
	case "mouse_scroll":
		return h.SendMouseScroll(event.X, event.Y, event.Delta)
	case "key_press":
		return h.SendKeyPress(event.Key, event.Modifiers)
	case "key_down":
		return h.SendKeyDown(event.Key)
	case "key_up":
		return h.SendKeyUp(event.Key)
	default:
		return fmt.Errorf("unknown event type: %s", event.Type)
	}
}

func charToVK(key string) uint16 {
	if len(key) == 1 {
		c := strings.ToUpper(key)[0]
		if c >= 'A' && c <= 'Z' {
			return uint16(c)
		}
		if c >= '0' && c <= '9' {
			return uint16(c)
		}
	}

	// Common special keys
	switch strings.ToLower(key) {
	case "enter", "return":
		return 0x0D
	case "tab":
		return 0x09
	case "space":
		return 0x20
	case "backspace":
		return 0x08
	case "escape", "esc":
		return 0x1B
	case "delete", "del":
		return 0x2E
	case "home":
		return 0x24
	case "end":
		return 0x23
	case "pageup":
		return 0x21
	case "pagedown":
		return 0x22
	case "up":
		return 0x26
	case "down":
		return 0x28
	case "left":
		return 0x25
	case "right":
		return 0x27
	case "f1":
		return 0x70
	case "f2":
		return 0x71
	case "f3":
		return 0x72
	case "f4":
		return 0x73
	case "f5":
		return 0x74
	case "f6":
		return 0x75
	case "f7":
		return 0x76
	case "f8":
		return 0x77
	case "f9":
		return 0x78
	case "f10":
		return 0x79
	case "f11":
		return 0x7A
	case "f12":
		return 0x7B
	}

	return 0
}
