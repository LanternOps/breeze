package desktop

import "strings"

// Windows keyboard-input tuple building, kept free of build tags so the
// decisions are unit-tested on every OS (the blocking agent CI job runs on
// Linux and never executes input_windows.go). input_windows.go only turns the
// tuple into an INPUT struct and calls SendInput.

// KEYEVENTF_* values (WinUser.h), duplicated untyped so this file builds
// everywhere. input_windows.go keeps its own exported-style names.
const (
	winKeyeventfExtendedKey = 0x0001
	winKeyeventfKeyUp       = 0x0002
	winKeyeventfScancode    = 0x0008
)

// winKeyInput is the KEYBDINPUT fields the agent sets for one key event.
type winKeyInput struct {
	VK    uint16
	Scan  uint16
	Flags uint32
}

// winCodeKey is a set-1 scancode; extended means the E0-prefixed table.
type winCodeKey struct {
	scan     uint16
	extended bool
}

// winCodeKeys maps DOM KeyboardEvent.code to the physical key for the keys
// that the key-name (VK) path cannot express or gets wrong (spec gotcha K11):
// left/right modifiers, the extended navigation cluster, Numpad Enter and
// Divide, F13–F24, ContextMenu, the ISO and JIS extra keys, and media keys.
//
// Deliberately absent:
//   - letters, digits and punctuation: a scancode is a position, so KeyA on an
//     AZERTY remote would type "q". The VK path keeps today's behaviour.
//   - CapsLock, NumLock, ScrollLock: driven by lock-state sync, and NumLock's
//     scancode collides with Pause's E1 sequence.
//   - Pause: an E1 sequence that one KEYBDINPUT cannot carry.
//
// A code not in this table falls back to the key name, never an error.
var winCodeKeys = map[string]winCodeKey{
	"ShiftLeft":    {0x2A, false},
	"ShiftRight":   {0x36, false},
	"ControlLeft":  {0x1D, false},
	"ControlRight": {0x1D, true},
	"AltLeft":      {0x38, false},
	"AltRight":     {0x38, true},
	"MetaLeft":     {0x5B, true},
	"MetaRight":    {0x5C, true},
	"OSLeft":       {0x5B, true}, // pre-2017 Firefox name for MetaLeft
	"OSRight":      {0x5C, true},
	"ContextMenu":  {0x5D, true},

	"NumpadEnter":  {0x1C, true},
	"NumpadDivide": {0x35, true},

	"ArrowUp":    {0x48, true},
	"ArrowDown":  {0x50, true},
	"ArrowLeft":  {0x4B, true},
	"ArrowRight": {0x4D, true},
	"Insert":     {0x52, true},
	"Delete":     {0x53, true},
	"Home":       {0x47, true},
	"End":        {0x4F, true},
	"PageUp":     {0x49, true},
	"PageDown":   {0x51, true},

	"F13": {0x64, false}, "F14": {0x65, false}, "F15": {0x66, false},
	"F16": {0x67, false}, "F17": {0x68, false}, "F18": {0x69, false},
	"F19": {0x6A, false}, "F20": {0x6B, false}, "F21": {0x6C, false},
	"F22": {0x6D, false}, "F23": {0x6E, false}, "F24": {0x76, false},

	"IntlBackslash": {0x56, false}, // ISO <> key, VK_OEM_102
	"IntlRo":        {0x73, false},
	"IntlYen":       {0x7D, false},

	"AudioVolumeMute":    {0x20, true},
	"AudioVolumeDown":    {0x2E, true},
	"AudioVolumeUp":      {0x30, true},
	"MediaTrackNext":     {0x19, true},
	"MediaTrackPrevious": {0x10, true},
	"MediaStop":          {0x24, true},
	"MediaPlayPause":     {0x22, true},
}

// winKeyInputFor builds the key event for code/key. A code in winCodeKeys is
// injected by scancode (wVk 0, KEYEVENTF_SCANCODE); anything else takes the
// key-name path exactly as before W2c: the VK, its MapVirtualKey scancode
// (scanOf), and the extended flag for the nav cluster. ok is false when
// neither identifies a key.
func winKeyInputFor(code, key string, up bool, scanOf func(vk uint16) uint16) (winKeyInput, bool) {
	var upFlag uint32
	if up {
		upFlag = winKeyeventfKeyUp
	}
	if ck, ok := winCodeKeys[code]; ok {
		flags := uint32(winKeyeventfScancode) | upFlag
		if ck.extended {
			flags |= winKeyeventfExtendedKey
		}
		return winKeyInput{Scan: ck.scan, Flags: flags}, true
	}
	vk := charToVK(key)
	if vk == 0 {
		return winKeyInput{}, false
	}
	flags := upFlag
	if isExtendedKey(vk) {
		flags |= winKeyeventfExtendedKey
	}
	return winKeyInput{VK: vk, Scan: scanOf(vk), Flags: flags}, true
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
	case "space", " ":
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

	// Modifier keys (when sent as standalone key presses, not modifiers)
	case "shift":
		return 0x10 // VK_SHIFT
	case "control", "ctrl":
		return 0x11 // VK_CONTROL
	case "alt":
		return 0x12 // VK_MENU
	case "meta", "super", "win", "lwin":
		return 0x5B // VK_LWIN
	case "rwin":
		return 0x5C // VK_RWIN

	// Misc
	case "printscreen":
		return 0x2C // VK_SNAPSHOT
	case "pause":
		return 0x13 // VK_PAUSE
	}

	return 0
}
