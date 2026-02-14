//go:build darwin && cgo

package desktop

/*
#include <CoreGraphics/CoreGraphics.h>

static void inputMouseMove(int x, int y) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake(x, y), 0);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void inputMouseDown(int x, int y, int button) {
    CGEventType type;
    switch (button) {
        case 1: type = kCGEventRightMouseDown; break;
        case 2: type = kCGEventOtherMouseDown; break;
        default: type = kCGEventLeftMouseDown; break;
    }
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), (CGMouseButton)button);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void inputMouseUp(int x, int y, int button) {
    CGEventType type;
    switch (button) {
        case 1: type = kCGEventRightMouseUp; break;
        case 2: type = kCGEventOtherMouseUp; break;
        default: type = kCGEventLeftMouseUp; break;
    }
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), (CGMouseButton)button);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void inputMouseDrag(int x, int y, int button) {
    CGEventType type;
    switch (button) {
        case 1: type = kCGEventRightMouseDragged; break;
        case 2: type = kCGEventOtherMouseDragged; break;
        default: type = kCGEventLeftMouseDragged; break;
    }
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), (CGMouseButton)button);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void inputMouseScroll(int delta) {
    CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, delta);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void inputKeyDown(int keycode, int flags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, true);
    if (event) {
        if (flags != 0) {
            CGEventSetFlags(event, (CGEventFlags)flags);
        }
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void inputKeyUp(int keycode, int flags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, false);
    if (event) {
        if (flags != 0) {
            CGEventSetFlags(event, (CGEventFlags)flags);
        }
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}
*/
import "C"

import (
	"fmt"
	"strings"
)

// macOS virtual keycodes (from Carbon HIToolbox/Events.h)
var keyNameToKeycode = map[string]int{
	// Letters (QWERTY layout keycodes)
	"a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04,
	"g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
	"b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F,
	"y": 0x10, "t": 0x11,

	// Digits
	"1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "5": 0x17,
	"6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19, "0": 0x1D,

	// Symbols
	"=": 0x18, "-": 0x1B, "]": 0x1E, "[": 0x21, "'": 0x27,
	";": 0x29, "\\": 0x2A, ",": 0x2B, "/": 0x2C, ".": 0x2F,
	"`": 0x32,

	// More letters
	"o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23, "l": 0x25,
	"j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,

	// Special keys
	"return": 0x24, "tab": 0x30, "space": 0x31,
	"backspace": 0x33, "escape": 0x35,
	"delete": 0x75, "insert": 0x72,

	// Navigation
	"up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
	"home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,

	// Function keys
	"f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
	"f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
	"f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,

	// Lock keys
	"capslock": 0x39, "numlock": 0x47,

	// Numpad
	"num0": 0x52, "num1": 0x53, "num2": 0x54, "num3": 0x55,
	"num4": 0x56, "num5": 0x57, "num6": 0x58, "num7": 0x59,
	"num8": 0x5B, "num9": 0x5C,
	"add": 0x45, "subtract": 0x4E, "multiply": 0x43,
	"divide": 0x4B, "decimal": 0x41,
}

// DarwinInputHandler handles input on macOS using CGEvents.
// Requires Accessibility permission (System Settings > Privacy > Accessibility).
type DarwinInputHandler struct {
	mouseDown bool // track if mouse button is held for drag events
	mouseBtn  int
}

func NewInputHandler() InputHandler {
	return &DarwinInputHandler{}
}

func buttonToInt(button string) int {
	switch strings.ToLower(button) {
	case "right":
		return 1
	case "middle":
		return 2
	default:
		return 0
	}
}

func modifiersToFlags(modifiers []string) C.int {
	var flags int
	for _, mod := range modifiers {
		switch strings.ToLower(mod) {
		case "shift":
			flags |= 0x00020000 // kCGEventFlagMaskShift
		case "ctrl", "control":
			flags |= 0x00040000 // kCGEventFlagMaskControl
		case "alt":
			flags |= 0x00080000 // kCGEventFlagMaskAlternate
		case "meta", "cmd", "win", "super":
			flags |= 0x00100000 // kCGEventFlagMaskCommand
		}
	}
	return C.int(flags)
}

func normalizeKeyName(key string) string {
	return strings.ToLower(strings.TrimSpace(key))
}

func (h *DarwinInputHandler) SendMouseMove(x, y int) error {
	if h.mouseDown {
		C.inputMouseDrag(C.int(x), C.int(y), C.int(h.mouseBtn))
	} else {
		C.inputMouseMove(C.int(x), C.int(y))
	}
	return nil
}

func (h *DarwinInputHandler) SendMouseClick(x, y int, button string) error {
	btn := C.int(buttonToInt(button))
	C.inputMouseDown(C.int(x), C.int(y), btn)
	C.inputMouseUp(C.int(x), C.int(y), btn)
	return nil
}

func (h *DarwinInputHandler) SendMouseDown(x, y int, button string) error {
	h.mouseBtn = buttonToInt(button)
	h.mouseDown = true
	C.inputMouseDown(C.int(x), C.int(y), C.int(h.mouseBtn))
	return nil
}

func (h *DarwinInputHandler) SendMouseUp(x, y int, button string) error {
	h.mouseDown = false
	C.inputMouseUp(C.int(x), C.int(y), C.int(buttonToInt(button)))
	return nil
}

func (h *DarwinInputHandler) SendMouseScroll(x, y int, delta int) error {
	C.inputMouseMove(C.int(x), C.int(y))
	C.inputMouseScroll(C.int(-delta)) // negate: browser deltaY+ = scroll down
	return nil
}

func (h *DarwinInputHandler) SendKeyPress(key string, modifiers []string) error {
	key = normalizeKeyName(key)
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	flags := modifiersToFlags(modifiers)
	C.inputKeyDown(C.int(keycode), flags)
	C.inputKeyUp(C.int(keycode), flags)
	return nil
}

func (h *DarwinInputHandler) SendKeyDown(key string) error {
	key = normalizeKeyName(key)
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	C.inputKeyDown(C.int(keycode), 0)
	return nil
}

func (h *DarwinInputHandler) SendKeyUp(key string) error {
	key = normalizeKeyName(key)
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	C.inputKeyUp(C.int(keycode), 0)
	return nil
}

func (h *DarwinInputHandler) HandleEvent(event InputEvent) error {
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
