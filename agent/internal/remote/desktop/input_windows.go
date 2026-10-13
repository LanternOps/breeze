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
	vkKeyScanW       = user32.NewProc("VkKeyScanW")
	getKeyState      = user32.NewProc("GetKeyState")
)

const (
	INPUT_MOUSE    = 0
	INPUT_KEYBOARD = 1

	MOUSEEVENTF_MOVE        = 0x0001
	MOUSEEVENTF_LEFTDOWN    = 0x0002
	MOUSEEVENTF_LEFTUP      = 0x0004
	MOUSEEVENTF_RIGHTDOWN   = 0x0008
	MOUSEEVENTF_RIGHTUP     = 0x0010
	MOUSEEVENTF_MIDDLEDOWN  = 0x0020
	MOUSEEVENTF_MIDDLEUP    = 0x0040
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

// Compile-time proof that the Windows handler offers literal text injection, so
// InjectText takes the layout-independent path rather than key synthesis.
var (
	_ TextTyper       = (*WindowsInputHandler)(nil)
	_ TypeCharHandler = (*WindowsInputHandler)(nil)
)

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

	// W2c lock-key sync (sequenced sessions only; see lockSyncFor).
	capsSync lockKeySync
	numSync  lockKeySync
}

// NewInputHandler creates a Windows input handler
func NewInputHandler(_ string) InputHandler {
	return &WindowsInputHandler{}
}

// InputAvailable always returns true on Windows — SendInput works in all
// desktop contexts including the Winlogon/UAC secure desktop.
func (h *WindowsInputHandler) InputAvailable() bool { return true }

func (h *WindowsInputHandler) SetDisplayOffset(x, y int) {
	h.mu.Lock()
	h.offsetX = x
	h.offsetY = y
	h.mu.Unlock()
}

func (h *WindowsInputHandler) SetAtLoginWindow(_ bool) {}

func (h *WindowsInputHandler) SendMouseMove(x, y int) error {
	// Ensure we're on the active input desktop. Without this, SendInput from
	// a standalone InputHandler (e.g., computer_action) is silently dropped
	// by Windows for DWM-managed elements (title bar, Start, taskbar).
	h.ensureInputDesktop()

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
	absX = int32(((x-h.cachedVX)*65535)/h.cachedCW + 1)
	absY = int32(((y-h.cachedVY)*65535)/h.cachedCH + 1)
	return absX, absY, true
}

func (h *WindowsInputHandler) SendMouseClick(x, y int, button string) error {
	// Ensure we're on the active input desktop so DWM-managed elements
	// (title bar buttons, Start menu, taskbar) receive the click.
	h.ensureInputDesktop()

	// Ensure screen metrics are cached for coordinate conversion.
	h.mu.Lock()
	if !h.metricsValid {
		h.refreshScreenMetrics()
	}
	h.mu.Unlock()

	// For non-drag clicks (like computer_action), send an atomic 3-event
	// sequence: move + button_down + button_up in a single SendInput call.
	// Many Windows UI frameworks (UWP, WinUI3, Electron) require position
	// data on the button events themselves and process them as a batch.
	// Separate SendInput calls can be split by the input queue, causing
	// window chrome (close/minimize/maximize, taskbar, Start) to ignore clicks.
	btn := winMouseButtonFor(button)
	downFlag, upFlag := btn.Down, btn.Up

	// Try absolute coordinate path for atomic click
	vx, vy, ok := h.screenToAbsolute(x, y)
	if ok {
		posFlags := MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
		events := [3]input{
			{inputType: INPUT_MOUSE},
			{inputType: INPUT_MOUSE},
			{inputType: INPUT_MOUSE},
		}
		// Event 0: move to position
		events[0].mi.dx = vx
		events[0].mi.dy = vy
		events[0].mi.dwFlags = uint32(posFlags)
		// Event 1: button down at position
		events[1].mi.dx = vx
		events[1].mi.dy = vy
		events[1].mi.dwFlags = uint32(posFlags) | downFlag
		events[1].mi.mouseData = btn.Data
		// Event 2: button up at position
		events[2].mi.dx = vx
		events[2].mi.dy = vy
		events[2].mi.dwFlags = uint32(posFlags) | upFlag
		events[2].mi.mouseData = btn.Data

		ret, _, _ := sendInput.Call(3, uintptr(unsafe.Pointer(&events[0])), unsafe.Sizeof(events[0]))
		if ret != 3 {
			slog.Debug("SendInput atomic click: not all events injected", "injected", ret)
		}
		return nil
	}

	// Fallback: SetCursorPos + separate events
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

	btn := winMouseButtonFor(button)
	inp := input{inputType: INPUT_MOUSE}
	inp.mi.dwFlags = btn.Down
	inp.mi.mouseData = btn.Data // XBUTTON1/2 for back/forward, else 0

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

	btn := winMouseButtonFor(button)
	inp := input{inputType: INPUT_MOUSE}
	inp.mi.dwFlags = btn.Up
	inp.mi.mouseData = btn.Data

	ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	if ret == 0 {
		slog.Debug("SendInput failed", "flags", inp.mi.dwFlags)
	}
	return nil
}

func (h *WindowsInputHandler) SendMouseScroll(x, y int, delta int) error {
	return h.sendMouseScroll(x, y, delta, 0)
}

// sendMouseScroll posts the wheel events winScrollInputs picks: the single
// pre-W2c WHEEL when deltaX is 0, plus an HWHEEL for a W2c deltaX.
func (h *WindowsInputHandler) sendMouseScroll(x, y, delta, deltaX int) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}

	for _, w := range winScrollInputs(delta, deltaX) {
		inp := input{inputType: INPUT_MOUSE}
		inp.mi.dwFlags = w.Flags
		inp.mi.mouseData = w.Data // multiples of WHEEL_DELTA (120)

		ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
		if ret == 0 {
			slog.Debug("SendInput failed", "flags", inp.mi.dwFlags)
		}
	}
	return nil
}

func (h *WindowsInputHandler) SendKeyPress(key string, modifiers []string) error {
	return h.sendKeyPress("", key, modifiers)
}

// sendKeyPress is SendKeyPress with the W2c physical key code. Modifiers stay
// on the VK path: they are names, not physical keys.
func (h *WindowsInputHandler) sendKeyPress(code, key string, modifiers []string) error {
	h.ensureInputDesktop()
	// Press modifiers
	for _, mod := range modifiers {
		h.sendModifierKey(mod, false)
	}

	// Press and release key
	if err := h.sendKeyDown(code, key); err != nil {
		// Still release modifiers before returning
		for i := len(modifiers) - 1; i >= 0; i-- {
			h.sendModifierKey(modifiers[i], true)
		}
		return err
	}
	h.sendKeyUp(code, key)

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
	var flags uint32
	if isExtendedKey(vk) {
		flags |= KEYEVENTF_EXTENDEDKEY
	}
	if up {
		flags |= KEYEVENTF_KEYUP
	}
	ki.dwFlags = flags

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

func (h *WindowsInputHandler) SendKeyDown(key string) error {
	return h.sendKeyDown("", key)
}

// sendKeyDown presses the key identified by code (W2c, scancode) or, when
// code is empty or not in winCodeKeys, by key name exactly as before W2c.
func (h *WindowsInputHandler) sendKeyDown(code, key string) error {
	h.ensureInputDesktop()
	k, ok := winKeyInputFor(code, key, false, vkToScanCode)
	if !ok {
		slog.Warn("Unknown key — no VK mapping, input dropped", "key", key)
		return fmt.Errorf("unknown key: %s", key)
	}
	if !sendKeybdInput(k) {
		return fmt.Errorf("SendInput failed for key_down vk=0x%X scan=0x%X", k.VK, k.Scan)
	}
	return nil
}

// sendKeybdInput posts one keyboard INPUT. False when SendInput injected none.
func sendKeybdInput(k winKeyInput) bool {
	inp := input{inputType: INPUT_KEYBOARD}
	ki := (*keybdInput)(unsafe.Pointer(&inp.mi))
	ki.wVk = k.VK
	ki.wScan = k.Scan
	ki.dwFlags = k.Flags
	ret, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	return ret != 0
}

const (
	vkCapital = 0x14 // VK_CAPITAL
	vkNumLock = 0x90 // VK_NUMLOCK
)

// syncLockKeys brings Caps Lock and Num Lock to the states plan asserts.
func (h *WindowsInputHandler) syncLockKeys(plan lockSyncPlan) {
	if plan.caps != nil {
		h.syncLockKey(&h.capsSync, vkCapital, *plan.caps)
	}
	if plan.num != nil {
		h.syncLockKey(&h.numSync, vkNumLock, *plan.num)
	}
}

// syncLockKey taps the lock key vk when its toggle state differs from want.
// GetKeyState's low bit is the toggle state.
func (h *WindowsInputHandler) syncLockKey(s *lockKeySync, vk uint16, want bool) {
	read := func() (bool, bool) {
		r, _, _ := getKeyState.Call(uintptr(vk))
		return r&1 != 0, true
	}
	if !s.next(want, read) {
		return
	}
	k := winKeyInput{VK: vk, Scan: vkToScanCode(vk)}
	if isExtendedKey(vk) {
		k.Flags = KEYEVENTF_EXTENDEDKEY
	}
	down := sendKeybdInput(k)
	k.Flags |= KEYEVENTF_KEYUP
	up := sendKeybdInput(k) // always attempted: never leave the lock key down
	if down && up {
		s.done(want)
		return
	}
	slog.Warn("Lock key sync tap failed", "vk", vk, "downOK", down, "upOK", up)
}

// windowsUnicodeChunkUnits is how many UTF-16 code units are posted per
// SendInput call (two INPUT structs each — a key-down and a key-up).
const windowsUnicodeChunkUnits = 64

// TypeText types a whole string using KEYEVENTF_UNICODE. This bypasses VK code
// mapping entirely, so the characters that arrive do not depend on the remote
// machine's keyboard layout — the macOS counterpart of the same guarantee is
// CGEventKeyboardSetUnicodeString (issue #4089).
func (h *WindowsInputHandler) TypeText(text string) error {
	h.ensureInputDesktop()
	for _, chunk := range chunkUTF16(text, windowsUnicodeChunkUnits) {
		if err := sendUnicodeUnits(chunk); err != nil {
			return err
		}
	}
	return nil
}

// TypeChar types a single Unicode character using KEYEVENTF_UNICODE.
// This bypasses VK code mapping entirely and works for any character
// including ":", "!", "@", non-ASCII, emoji, etc.
func (h *WindowsInputHandler) TypeChar(ch rune) error {
	return h.TypeText(string(ch))
}

// sendUnicodeUnits posts a key-down/key-up pair for each UTF-16 code unit in a
// single SendInput call.
//
// The INPUT structs are built in one slice because SendInput reads cInputs
// *contiguous* structs from the pointer it is given. The previous version passed
// cInputs=2 with a pointer to a local `down` variable while `up` was a separate
// local — Go makes no adjacency guarantee, so the second struct was whatever
// memory happened to follow `down` and the key-up was never reliably delivered.
//
// Iterating code units rather than runes also fixes non-BMP characters: wScan is
// a single UTF-16 unit, so a rune above U+FFFF must be sent as its surrogate
// pair rather than truncated to 16 bits.
func sendUnicodeUnits(units []uint16) error {
	if len(units) == 0 {
		return nil
	}

	events := make([]input, 0, len(units)*2)
	for _, unit := range units {
		down := input{inputType: INPUT_KEYBOARD}
		ki := (*keybdInput)(unsafe.Pointer(&down.mi))
		ki.wVk = 0
		ki.wScan = unit
		ki.dwFlags = KEYEVENTF_UNICODE

		up := input{inputType: INPUT_KEYBOARD}
		kiUp := (*keybdInput)(unsafe.Pointer(&up.mi))
		kiUp.wVk = 0
		kiUp.wScan = unit
		kiUp.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP

		events = append(events, down, up)
	}

	sent, _, callErr := sendInput.Call(
		uintptr(len(events)),
		uintptr(unsafe.Pointer(&events[0])),
		unsafe.Sizeof(events[0]),
	)
	if int(sent) != len(events) {
		if errno, ok := callErr.(syscall.Errno); ok && errno != 0 {
			return fmt.Errorf("SendInput UNICODE injected %d of %d events: %w", int(sent), len(events), errno)
		}
		return fmt.Errorf("SendInput UNICODE injected %d of %d events", int(sent), len(events))
	}
	return nil
}

func (h *WindowsInputHandler) SendKeyUp(key string) error {
	return h.sendKeyUp("", key)
}

// sendKeyUp releases what sendKeyDown(code, key) pressed: the same code and
// key resolve to the same physical key, so a right Ctrl pressed by scancode
// is released by scancode rather than as VK_CONTROL (left Ctrl).
func (h *WindowsInputHandler) sendKeyUp(code, key string) error {
	k, ok := winKeyInputFor(code, key, true, vkToScanCode)
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	if !sendKeybdInput(k) {
		return fmt.Errorf("SendInput failed for key_up vk=0x%X scan=0x%X", k.VK, k.Scan)
	}
	return nil
}

// ensureInputDesktop switches the input handler's thread to the active input
// desktop so that SendInput works on the Winlogon/UAC secure desktop.
// Only re-checks every 500ms to avoid overhead on every input event.
func (h *WindowsInputHandler) ensureInputDesktop() {
	h.mu.Lock()
	now := time.Now()
	if now.Sub(h.lastDesktopSync) < 500*time.Millisecond {
		h.mu.Unlock()
		return
	}
	h.lastDesktopSync = now
	needsLock := !h.threadLocked
	h.mu.Unlock()

	// LockOSThread must be called outside the mutex to avoid scheduler issues.
	if needsLock {
		runtime.LockOSThread()
		h.mu.Lock()
		h.threadLocked = true
		h.mu.Unlock()
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
	h.mu.Lock()
	oldDesktop := h.currentDesktop
	h.currentDesktop = hDesk
	h.mu.Unlock()

	if oldDesktop != 0 {
		procCloseDesktop.Call(oldDesktop)
	}
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
		return h.sendMouseScroll(event.X, event.Y, event.Delta, event.DeltaX)
	case "key_press", "key_down", "key_up":
		return h.handleKeyEvent(event)
	default:
		return fmt.Errorf("unknown event type: %s", event.Type)
	}
}

// handleKeyEvent injects a key event, first bringing Caps Lock and Num Lock
// to the state the viewer asserts (sequenced sessions only; see lockSyncFor).
// A lock key whose state is being asserted is not injected: the sync already
// made the state right, and pressing it as well would flip it back.
func (h *WindowsInputHandler) handleKeyEvent(event InputEvent) error {
	if plan := lockSyncFor(event); plan.active {
		h.syncLockKeys(plan)
		if plan.suppress(true, true) { // GetKeyState always answers
			return nil
		}
	}
	switch event.Type {
	case "key_press":
		return h.sendKeyPress(event.Code, event.Key, event.Modifiers)
	case "key_down":
		return h.sendKeyDown(event.Code, event.Key)
	default:
		return h.sendKeyUp(event.Code, event.Key)
	}
}
