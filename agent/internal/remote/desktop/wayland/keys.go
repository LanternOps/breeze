package wayland

import "strings"

// Keycode maps a viewer key name to a Linux evdev code (KEY_*). Portal
// NotifyKeyboardKeycode takes these codes, not X keysyms.
func Keycode(name string) (uint32, bool) {
	if name == "" {
		return 0, false
	}
	if code, ok := namedKeys[strings.ToLower(name)]; ok {
		return code, true
	}
	r := []rune(name)
	if len(r) != 1 {
		return 0, false
	}
	if code, ok := namedKeys[strings.ToLower(string(r))]; ok {
		return code, true
	}
	return 0, false
}

// buttonCode maps a viewer button name to an evdev BTN_* code.
func buttonCode(name string) uint32 {
	switch strings.ToLower(name) {
	case "right":
		return 0x111
	case "middle":
		return 0x112
	case "back":
		return 0x113
	case "forward":
		return 0x114
	default:
		return 0x110
	}
}

// namedKeys covers the viewer names the X11 path already accepts.
// Letter and digit codes follow linux/input-event-codes.h (they are not
// contiguous alphabetically).
var namedKeys = map[string]uint32{
	"esc": 1, "escape": 1,
	"1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
	"-": 12, "=": 13,
	"backspace": 14, "tab": 15,
	"q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22, "i": 23, "o": 24, "p": 25,
	"[": 26, "]": 27, "enter": 28, "return": 28,
	"ctrl": 29, "control": 29,
	"a": 30, "s": 31, "d": 32, "f": 33, "g": 34, "h": 35, "j": 36, "k": 37, "l": 38,
	";": 39, "'": 40, "`": 41,
	"shift": 42,
	"\\":    43,
	"z":     44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50,
	",": 51, ".": 52, "/": 53,
	"alt":   56,
	"space": 57, " ": 57,
	"capslock": 58,
	"f1":       59, "f2": 60, "f3": 61, "f4": 62, "f5": 63, "f6": 64, "f7": 65, "f8": 66, "f9": 67, "f10": 68,
	"numlock": 69, "scrolllock": 70,
	"num7": 71, "num8": 72, "num9": 73,
	"subtract": 74, "kp_subtract": 74,
	"num4": 75, "num5": 76, "num6": 77,
	"add": 78, "kp_add": 78,
	"num1": 79, "num2": 80, "num3": 81, "num0": 82,
	"decimal": 83, "kp_decimal": 83,
	"f11": 87, "f12": 88,
	"multiply": 55, "kp_multiply": 55,
	"divide": 98, "kp_divide": 98,
	"home": 102, "up": 103, "pageup": 104, "left": 105, "right": 106,
	"end": 107, "down": 108, "pagedown": 109, "insert": 110,
	"delete": 111, "del": 111,
	"pause": 119,
	"super": 125, "meta": 125, "cmd": 125, "win": 125,
	"printscreen": 99, "print": 99,
}
