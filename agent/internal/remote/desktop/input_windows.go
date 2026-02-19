//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	sendInput        = user32.NewProc("SendInput")
	setcursorpos     = user32.NewProc("SetCursorPos")
	mapvirtualkey    = user32.NewProc("MapVirtualKeyW")
	getSystemMetrics = user32.NewProc("GetSystemMetrics")
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
	MOUSEEVENTF_WHEEL       = 0x0800
	MOUSEEVENTF_ABSOLUTE    = 0x8000
	MOUSEEVENTF_VIRTUALDESK = 0x4000

	SM_XVIRTUALSCREEN  = 76
	SM_YVIRTUALSCREEN  = 77
	SM_CXVIRTUALSCREEN = 78
	SM_CYVIRTUALSCREEN = 79

	KEYEVENTF_KEYUP       = 0x0002
	KEYEVENTF_UNICODE     = 0x0004
	KEYEVENTF_SCANCODE    = 0x0008
	KEYEVENTF_EXTENDEDKEY = 0x0001

	MAPVK_VK_TO_VSC = 0

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
type WindowsInputHandler struct {
	mu           sync.Mutex
	buttonDown   bool // true while any mouse button is held (between down/up)
	offsetX      int  // virtual screen X offset of captured monitor
	offsetY      int  // virtual screen Y offset of captured monitor
	cachedVX     int
	cachedVY     int
	cachedCW     int
	cachedCH     int
	metricsValid bool

	// Secure desktop support: the input handler goroutine must be on the
	// same desktop as the active input desktop for SendInput to work.
	threadLocked    bool
	lastDesktopSync time.Time
	currentDesktop  uintptr
}

// NewInputHandler creates a Windows input handler
func NewInputHandler() InputHandler {
	return &WindowsInputHandler{}
}

func (h *WindowsInputHandler) SetDisplayOffset(x, y int) {
	h.mu.Lock()
	h.offsetX = x
	h.offsetY = y
	h.mu.Unlock()
}

func (h *WindowsInputHandler) SendMouseMove(x, y int) error {
	h.mu.Lock()
	dragging := h.buttonDown
	h.mu.Unlock()

	if dragging {
		// During a drag, use SendInput so the move goes through the Windows
		// input queue and respects mouse capture. Without this, apps like
		// Windows Terminal don't see WM_MOUSEMOVE with MK_LBUTTON and
		// click-drag text selection breaks.
		vx, vy, ok := h.screenToAbsolute(x, y)
		if ok {
			inp := input{inputType: INPUT_MOUSE}
			inp.mi.dx = vx
			inp.mi.dy = vy
			inp.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
			ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
			if ret == 0 {
				slog.Debug("SendInput failed", "flags", inp.mi.dwFlags)
			}
			return nil
		}
	}
	// Normal hover: use SetCursorPos — fast and auto-coalesces rapid moves.
	ret, _, _ := setcursorpos.Call(uintptr(x), uintptr(y))
	if ret == 0 {
		return fmt.Errorf("SetCursorPos failed")
	}
	return nil
}

// refreshScreenMetrics refreshes the cached virtual screen metrics.
// Caller must hold h.mu.
func (h *WindowsInputHandler) refreshScreenMetrics() {
	vx, _, _ := getSystemMetrics.Call(SM_XVIRTUALSCREEN)
	vy, _, _ := getSystemMetrics.Call(SM_YVIRTUALSCREEN)
	cw, _, _ := getSystemMetrics.Call(SM_CXVIRTUALSCREEN)
	ch, _, _ := getSystemMetrics.Call(SM_CYVIRTUALSCREEN)
	h.cachedVX, h.cachedVY = int(vx), int(vy)
	h.cachedCW, h.cachedCH = int(cw), int(ch)
	h.metricsValid = h.cachedCW > 0 && h.cachedCH > 0
}

// screenToAbsolute converts screen coordinates to the normalized 0–65535
// coordinate space required by MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK.
func (h *WindowsInputHandler) screenToAbsolute(x, y int) (absX, absY int32, ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.metricsValid {
		return 0, 0, false
	}
	absX = int32(((x - h.cachedVX) * 65536) / h.cachedCW)
	absY = int32(((y - h.cachedVY) * 65536) / h.cachedCH)
	return absX, absY, true
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
	h.mu.Lock()
	h.buttonDown = true
	h.refreshScreenMetrics() // cache once per drag — avoid 4 syscalls per move
	h.mu.Unlock()

	// Position cursor before pressing — without this, the button press fires
	// at the previous cursor location and drag-select operations start from
	// the wrong origin (e.g. terminal text selection fails).
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}

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

	ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	if ret == 0 {
		slog.Debug("SendInput failed", "flags", inp.mi.dwFlags)
	}
	return nil
}

func (h *WindowsInputHandler) SendMouseUp(x, y int, button string) error {
	// Position cursor before releasing — ensures the release lands at the
	// correct end-of-drag coordinate (e.g. for text selection).
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}

	h.mu.Lock()
	h.buttonDown = false
	h.mu.Unlock()

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

	ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	if ret == 0 {
		slog.Debug("SendInput failed", "flags", inp.mi.dwFlags)
	}
	return nil
}

func (h *WindowsInputHandler) SendMouseScroll(x, y int, delta int) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}

	inp := input{inputType: INPUT_MOUSE}
	inp.mi.dwFlags = MOUSEEVENTF_WHEEL
	// Negate: browser deltaY positive = scroll down, but Windows WHEEL positive = scroll up
	inp.mi.mouseData = uint32(-delta * 120) // Windows uses multiples of WHEEL_DELTA (120)

	ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	if ret == 0 {
		slog.Debug("SendInput failed", "flags", inp.mi.dwFlags)
	}
	return nil
}

func (h *WindowsInputHandler) SendKeyPress(key string, modifiers []string) error {
	// Press modifiers
	for _, mod := range modifiers {
		h.sendModifierKey(mod, false)
	}

	// Press and release key
	if err := h.SendKeyDown(key); err != nil {
		// Still release modifiers before returning
		for i := len(modifiers) - 1; i >= 0; i-- {
			h.sendModifierKey(modifiers[i], true)
		}
		return err
	}
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
	case "meta", "cmd":
		// Mac Cmd → Windows Ctrl so copy/paste/undo behave as expected
		vk = VK_CONTROL
	case "win":
		vk = VK_LWIN
	default:
		return
	}

	inp := input{inputType: INPUT_KEYBOARD}
	ki := (*keybdInput)(unsafe.Pointer(&inp.mi))
	ki.wVk = vk
	ki.wScan = vkToScanCode(vk)
	if up {
		ki.dwFlags = KEYEVENTF_KEYUP
	}

	ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	if ret == 0 {
		slog.Debug("SendInput failed", "flags", ki.dwFlags)
	}
}

// vkToScanCode uses MapVirtualKeyW to derive the hardware scan code for a VK.
// Many Windows apps (e.g. RDP, games, some text editors) require the scan code
// field to be populated in the INPUT struct for key events to register.
func vkToScanCode(vk uint16) uint16 {
	sc, _, _ := mapvirtualkey.Call(uintptr(vk), MAPVK_VK_TO_VSC)
	return uint16(sc)
}

// isExtendedKey returns true for keys that require the KEYEVENTF_EXTENDEDKEY flag
// (right-hand nav cluster, numpad enter, etc.).
func isExtendedKey(vk uint16) bool {
	switch vk {
	case 0x21, 0x22, 0x23, 0x24, // PageUp, PageDown, End, Home
		0x25, 0x26, 0x27, 0x28, // Arrow keys
		0x2D, 0x2E, // Insert, Delete
		0x5B, 0x5C, // LWin, RWin
		0x6F, // Numpad Divide
		0x90, // NumLock
		0x91, // ScrollLock
		0x2C: // PrintScreen
		return true
	}
	return false
}

func (h *WindowsInputHandler) SendKeyDown(key string) error {
	vk := charToVK(key)
	if vk == 0 {
		slog.Warn("Unknown key — no VK mapping, input dropped", "key", key)
		return fmt.Errorf("unknown key: %s", key)
	}

	inp := input{inputType: INPUT_KEYBOARD}
	ki := (*keybdInput)(unsafe.Pointer(&inp.mi))
	ki.wVk = vk
	ki.wScan = vkToScanCode(vk)
	if isExtendedKey(vk) {
		ki.dwFlags = KEYEVENTF_EXTENDEDKEY
	}

	ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	if ret == 0 {
		return fmt.Errorf("SendInput failed for key_down vk=0x%X", vk)
	}
	return nil
}

func (h *WindowsInputHandler) SendKeyUp(key string) error {
	vk := charToVK(key)
	if vk == 0 {
		return fmt.Errorf("unknown key: %s", key)
	}

	inp := input{inputType: INPUT_KEYBOARD}
	ki := (*keybdInput)(unsafe.Pointer(&inp.mi))
	ki.wVk = vk
	ki.wScan = vkToScanCode(vk)
	ki.dwFlags = KEYEVENTF_KEYUP
	if isExtendedKey(vk) {
		ki.dwFlags |= KEYEVENTF_EXTENDEDKEY
	}

	ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	if ret == 0 {
		return fmt.Errorf("SendInput failed for key_up vk=0x%X", vk)
	}
	return nil
}

// ensureInputDesktop switches the input handler's thread to the active input
// desktop so that SendInput works on the Winlogon/UAC secure desktop.
// Only re-checks every 500ms to avoid overhead on every input event.
func (h *WindowsInputHandler) ensureInputDesktop() {
	now := time.Now()
	if now.Sub(h.lastDesktopSync) < 500*time.Millisecond {
		return
	}
	h.lastDesktopSync = now

	if !h.threadLocked {
		runtime.LockOSThread()
		h.threadLocked = true
	}

	hDesk, _, _ := procOpenInputDesktop.Call(0, 0, uintptr(desktopGenericAll))
	if hDesk == 0 {
		return
	}

	ret, _, _ := procSetThreadDesktop.Call(hDesk)
	if ret == 0 {
		// Already on this desktop, or can't switch — close the handle.
		procCloseDesktop.Call(hDesk)
		return
	}

	// Successfully switched — close old handle, store new one.
	if h.currentDesktop != 0 {
		procCloseDesktop.Call(h.currentDesktop)
	}
	h.currentDesktop = hDesk
}

func (h *WindowsInputHandler) HandleEvent(event InputEvent) error {
	// Ensure we're on the active input desktop (handles Winlogon/UAC switch).
	h.ensureInputDesktop()

	// Translate viewer-relative coordinates to virtual screen coordinates.
	h.mu.Lock()
	event.X += h.offsetX
	event.Y += h.offsetY
	h.mu.Unlock()

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
	// Single ASCII letters → VK_A..VK_Z (0x41..0x5A)
	// Single ASCII digits  → VK_0..VK_9 (0x30..0x39)
	if len(key) == 1 {
		c := key[0]
		if c >= 'a' && c <= 'z' {
			return uint16(c - 'a' + 'A')
		}
		if c >= 'A' && c <= 'Z' {
			return uint16(c)
		}
		if c >= '0' && c <= '9' {
			return uint16(c)
		}
	}

	switch strings.ToLower(key) {
	// Whitespace / editing
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
	case "insert":
		return 0x2D

	// Navigation
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

	// Function keys
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

	// Symbol keys (OEM VK codes — US keyboard layout)
	case "-":
		return 0xBD // VK_OEM_MINUS
	case "=":
		return 0xBB // VK_OEM_PLUS (the =/+ key)
	case "[":
		return 0xDB // VK_OEM_4
	case "]":
		return 0xDD // VK_OEM_6
	case "\\":
		return 0xDC // VK_OEM_5
	case ";":
		return 0xBA // VK_OEM_1
	case "'":
		return 0xDE // VK_OEM_7
	case "`":
		return 0xC0 // VK_OEM_3
	case ",":
		return 0xBC // VK_OEM_COMMA
	case ".":
		return 0xBE // VK_OEM_PERIOD
	case "/":
		return 0xBF // VK_OEM_2

	// Numpad
	case "num0":
		return 0x60 // VK_NUMPAD0
	case "num1":
		return 0x61
	case "num2":
		return 0x62
	case "num3":
		return 0x63
	case "num4":
		return 0x64
	case "num5":
		return 0x65
	case "num6":
		return 0x66
	case "num7":
		return 0x67
	case "num8":
		return 0x68
	case "num9":
		return 0x69
	case "multiply":
		return 0x6A // VK_MULTIPLY
	case "add":
		return 0x6B // VK_ADD
	case "subtract":
		return 0x6D // VK_SUBTRACT
	case "decimal":
		return 0x6E // VK_DECIMAL
	case "divide":
		return 0x6F // VK_DIVIDE

	// Lock / toggle keys
	case "capslock":
		return 0x14 // VK_CAPITAL
	case "numlock":
		return 0x90 // VK_NUMLOCK
	case "scrolllock":
		return 0x91 // VK_SCROLL

	// Misc
	case "printscreen":
		return 0x2C // VK_SNAPSHOT
	case "pause":
		return 0x13 // VK_PAUSE
	}

	return 0
}
