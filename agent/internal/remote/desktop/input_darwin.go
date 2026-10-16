//go:build darwin && cgo

package desktop

/*
#include <CoreGraphics/CoreGraphics.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/hidsystem/IOHIDLib.h>
#include <IOKit/hidsystem/event_status_driver.h>
#include <mach/mach.h>

// ---- IOHIDPostEvent wrappers for login-window input ----
// IOHIDPostEvent is deprecated since macOS 11 but still functional and is
// the only way to inject input at the login window where CGEvent is blocked.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static io_connect_t g_hidConnection = 0;
static int g_hidLastKernReturn = 0;

static int openHIDConnection(void) {
    if (g_hidConnection != 0) return 0;
    io_service_t service = IOServiceGetMatchingService(
        kIOMainPortDefault,
        IOServiceMatching("IOHIDSystem")
    );
    if (!service) {
        g_hidLastKernReturn = 0;
        return -1;
    }
    kern_return_t kr = IOServiceOpen(service, mach_task_self(),
                                     kIOHIDServerConnectType, &g_hidConnection);
    IOObjectRelease(service);
    g_hidLastKernReturn = (int)kr;
    return (kr == KERN_SUCCESS) ? 0 : -2;
}

static int hidLastKernReturn(void) {
    return g_hidLastKernReturn;
}

static void closeHIDConnection(void) {
    if (g_hidConnection != 0) {
        IOServiceClose(g_hidConnection);
        g_hidConnection = 0;
    }
}

// flags is the eventFlags argument: 0 (as before W2c) unless the agent holds
// modifiers. button >= 3 (W2c back/forward) is an other-mouse event that names
// its button; 0..2 post exactly what they did before.
static void hidMouseMove(int x, int y, int flags) {
    NXEventData eventData = {0};
    IOGPoint location = {(float)x, (float)y};
    IOHIDPostEvent(g_hidConnection, NX_MOUSEMOVED, location, &eventData,
                   kNXEventDataVersion, flags, 0);
}

static void hidMouseButton(int x, int y, int button, int flags, int left, int right, int other) {
    NXEventData eventData = {0};
    IOGPoint location = {(float)x, (float)y};
    int eventType;
    switch (button) {
        case 0:  eventType = left; break;
        case 1:  eventType = right; break;
        default: eventType = other; break;
    }
    if (button >= 3) {
        eventData.mouse.buttonNumber = button;
    }
    IOHIDPostEvent(g_hidConnection, eventType, location, &eventData,
                   kNXEventDataVersion, flags, 0);
}

static void hidMouseDown(int x, int y, int button, int flags) {
    hidMouseButton(x, y, button, flags, NX_LMOUSEDOWN, NX_RMOUSEDOWN, NX_OMOUSEDOWN);
}

static void hidMouseUp(int x, int y, int button, int flags) {
    hidMouseButton(x, y, button, flags, NX_LMOUSEUP, NX_RMOUSEUP, NX_OMOUSEUP);
}

static void hidMouseDrag(int x, int y, int button, int flags) {
    hidMouseButton(x, y, button, flags, NX_LMOUSEDRAGGED, NX_RMOUSEDRAGGED, NX_OMOUSEDRAGGED);
}

static void hidMouseScroll(int delta, int deltaAxis2, int flags) {
    NXEventData eventData = {0};
    eventData.scrollWheel.deltaAxis1 = delta;
    eventData.scrollWheel.deltaAxis2 = deltaAxis2;
    IOGPoint location = {0, 0};
    IOHIDPostEvent(g_hidConnection, NX_SCROLLWHEELMOVED, location, &eventData,
                   kNXEventDataVersion, flags, 0);
}

// W2c: a modifier key going down or up. flags is the complete modifier state
// after the change.
static void hidFlagsChanged(int keycode, int flags) {
    NXEventData eventData = {0};
    eventData.key.keyCode = keycode;
    IOGPoint location = {0, 0};
    IOHIDPostEvent(g_hidConnection, NX_FLAGSCHANGED, location, &eventData,
                   kNXEventDataVersion, flags, 0);
}

static void hidKeyDown(int keycode, int flags) {
    NXEventData eventData = {0};
    eventData.key.keyCode = keycode;
    IOGPoint location = {0, 0};
    IOHIDPostEvent(g_hidConnection, NX_KEYDOWN, location, &eventData,
                   kNXEventDataVersion, flags, 0);
}

static void hidKeyUp(int keycode, int flags) {
    NXEventData eventData = {0};
    eventData.key.keyCode = keycode;
    IOGPoint location = {0, 0};
    IOHIDPostEvent(g_hidConnection, NX_KEYUP, location, &eventData,
                   kNXEventDataVersion, flags, 0);
}

#pragma clang diagnostic pop

// ---- CGEvent wrappers (existing, for user-session) ----

// Returns the backing scale factor (2.0 on Retina, 1.0 otherwise) for the
// main display using CoreGraphics display mode pixel vs logical dimensions.
static double getMainDisplayScaleFactor(void) {
    CGDirectDisplayID mainDisplay = CGMainDisplayID();
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(mainDisplay);
    if (!mode) return 1.0;
    size_t pixelWidth = CGDisplayModeGetPixelWidth(mode);
    size_t logicalWidth = CGDisplayModeGetWidth(mode);
    CGDisplayModeRelease(mode);
    if (logicalWidth > 0) {
        return (double)pixelWidth / (double)logicalWidth;
    }
    return 1.0;
}

// tap selects the event tap: 0 = kCGHIDEventTap (user session), 1 =
// kCGSessionEventTap (login-window fallback, see below).
static CGEventTapLocation tapFor(int tap) {
    return tap ? kCGSessionEventTap : kCGHIDEventTap;
}

// Button 0 is left, 1 right, anything else an other-mouse button (2 middle,
// and for W2c 3 back, 4 forward). The CGMouseButton is the number itself.
static CGEventType mouseTypeFor(int button, CGEventType left, CGEventType right, CGEventType other) {
    switch (button) {
        case 0:  return left;
        case 1:  return right;
        default: return other;
    }
}

// setFlags 0 leaves the event's flags as CoreGraphics creates them (the
// behaviour before W2c); 1 sets them to `flags`, the modifiers the agent holds.
static void postMouse(int tap, CGEventType type, int x, int y, int button, int flags, int setFlags) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, CGPointMake(x, y), (CGMouseButton)button);
    if (event) {
        if (setFlags) {
            CGEventSetFlags(event, (CGEventFlags)flags);
        }
        CGEventPost(tapFor(tap), event);
        CFRelease(event);
    }
}

static void cgMouseMove(int tap, int x, int y, int flags, int setFlags) {
    postMouse(tap, kCGEventMouseMoved, x, y, 0, flags, setFlags);
}

static void cgMouseDown(int tap, int x, int y, int button, int flags, int setFlags) {
    postMouse(tap, mouseTypeFor(button, kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventOtherMouseDown),
              x, y, button, flags, setFlags);
}

static void cgMouseUp(int tap, int x, int y, int button, int flags, int setFlags) {
    postMouse(tap, mouseTypeFor(button, kCGEventLeftMouseUp, kCGEventRightMouseUp, kCGEventOtherMouseUp),
              x, y, button, flags, setFlags);
}

static void cgMouseDrag(int tap, int x, int y, int button, int flags, int setFlags) {
    postMouse(tap, mouseTypeFor(button, kCGEventLeftMouseDragged, kCGEventRightMouseDragged, kCGEventOtherMouseDragged),
              x, y, button, flags, setFlags);
}

// axes 1 is the pre-W2c vertical-only event; 2 adds the horizontal wheel.
static void cgMouseScroll(int tap, int axes, int wheel1, int wheel2, int flags, int setFlags) {
    CGEventRef event = (axes == 2)
        ? CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, wheel1, wheel2)
        : CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, wheel1);
    if (event) {
        if (setFlags) {
            CGEventSetFlags(event, (CGEventFlags)flags);
        }
        CGEventPost(tapFor(tap), event);
        CFRelease(event);
    }
}

// W2c: a modifier key going down or up, posted as kCGEventFlagsChanged with
// the complete modifier state after the change.
static void cgFlagsChanged(int tap, int keycode, int flags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, true);
    if (event) {
        CGEventSetType(event, kCGEventFlagsChanged);
        CGEventSetFlags(event, (CGEventFlags)flags);
        CGEventPost(tapFor(tap), event);
        CFRelease(event);
    }
}

// setFlags selects how the event's modifier flags are handled:
//
//   1 — call CGEventSetFlags unconditionally, so `flags` is the COMPLETE
//       modifier state and anything still held is cleared. Used for key
//       presses, where a stale modifier bleeding in is the "aggressive
//       uppercasing" of issue #4089 (and, on the Return that separates two
//       lines of a pasted shell block, turns Shift+Return into a line break
//       that never executes the command).
//   0 — leave the event's ambient flags alone unless `flags` is non-zero. The
//       viewer holds a modifier down across several events (Shift+Click,
//       Cmd+Click) by sending key_down for the modifier alone; explicitly
//       zeroing the flags on those would immediately drop the modifier it just
//       asked to hold.
static void inputKeyDown(int keycode, int flags, int setFlags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, true);
    if (event) {
        if (setFlags || flags != 0) {
            CGEventSetFlags(event, (CGEventFlags)flags);
        }
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

static void inputKeyUp(int keycode, int flags, int setFlags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, false);
    if (event) {
        if (setFlags || flags != 0) {
            CGEventSetFlags(event, (CGEventFlags)flags);
        }
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
}

// ---- CGEvent wrappers posted to kCGSessionEventTap ----
// At the macOS login window, IOHIDSystem is typically held exclusively
// (WindowServer / loginagent) so IOHIDPostEvent fails. CGEvents posted
// to kCGHIDEventTap also tend to be dropped at the login window. But
// posting to kCGSessionEventTap delivers events into the session-level
// tap, which on modern macOS is the correct target for login-window
// input injection from a privileged helper.

// setFlags has the same meaning as in inputKeyDown above.
static void sessionKeyDown(int keycode, int flags, int setFlags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, true);
    if (event) {
        if (setFlags || flags != 0) {
            CGEventSetFlags(event, (CGEventFlags)flags);
        }
        CGEventPost(kCGSessionEventTap, event);
        CFRelease(event);
    }
}

static void sessionKeyUp(int keycode, int flags, int setFlags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, false);
    if (event) {
        if (setFlags || flags != 0) {
            CGEventSetFlags(event, (CGEventFlags)flags);
        }
        CGEventPost(kCGSessionEventTap, event);
        CFRelease(event);
    }
}

// ---- Literal Unicode injection (issue #4089) ----
// CGEventKeyboardSetUnicodeString overrides the characters a keyboard event
// produces, so the string is delivered exactly as given no matter what the
// remote machine's active input source is. That is the whole point: the keycode
// table above is US ANSI, so replaying a paste through it renders '/' as '?' and
// '=' as '+' on a non-US layout.
//
// The event is created with virtual keycode 0 (no physical key) and both the
// down and the up event carry the string, which is what AppKit-based typing
// helpers do — a receiver that reads characters on key-down gets them once, and
// one that reads on key-up is not left with a mismatched empty event.
//
// Flags are set to 0 EXPLICITLY rather than left alone. The keycode helpers
// above only ever OR modifier bits in and never clear them, so a modifier still
// held from an earlier event would otherwise bleed into the pasted text — the
// "aggressive uppercasing" reported in #4089.
static void postUnicodeString(CGEventTapLocation tap, const UniChar *chars, int len) {
    if (len <= 0) {
        return;
    }
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
    if (down) {
        CGEventSetFlags(down, (CGEventFlags)0);
        CGEventKeyboardSetUnicodeString(down, (UniCharCount)len, chars);
        CGEventPost(tap, down);
        CFRelease(down);
    }
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
    if (up) {
        CGEventSetFlags(up, (CGEventFlags)0);
        CGEventKeyboardSetUnicodeString(up, (UniCharCount)len, chars);
        CGEventPost(tap, up);
        CFRelease(up);
    }
}

static void inputTypeUnicode(const UniChar *chars, int len) {
    postUnicodeString(kCGHIDEventTap, chars, len);
}

static void sessionTypeUnicode(const UniChar *chars, int len) {
    postUnicodeString(kCGSessionEventTap, chars, len);
}
*/
// #cgo LDFLAGS: -framework IOKit
import "C"

import (
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"unsafe"
)

// Compile-time proof that the macOS handler offers literal text injection, so
// InjectText takes the layout-independent path rather than key synthesis.
var (
	_ TextTyper       = (*DarwinInputHandler)(nil)
	_ TypeCharHandler = (*DarwinInputHandler)(nil)
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
	"return": 0x24, "tab": 0x30, "space": 0x31, " ": 0x31,
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

// DarwinInputHandler handles input on macOS using CGEvents (user session)
// or IOHIDPostEvent (login window). Requires Accessibility permission.
type DarwinInputHandler struct {
	mouseDown      bool // track if mouse button is held for drag events
	mouseBtn       int
	scaleFactor    float64 // backing scale factor (2.0 on Retina)
	hidAvailable   bool
	atLoginWindow  atomic.Bool
	inputAvailable bool

	// mods is the W2c running modifier mask (input_macflags.go): modifiers
	// held by sequenced key_down events, set on every later key and mouse
	// event. Empty in legacy sessions, so their events are unchanged.
	mods macModifierMask
}

func NewInputHandler(desktopContext string) InputHandler {
	sf := float64(C.getMainDisplayScaleFactor())
	if sf < 1.0 {
		sf = 1.0
	}
	h := &DarwinInputHandler{scaleFactor: sf, inputAvailable: true}

	// Always try to open HID connection regardless of context.
	// IOHIDPostEvent is the preferred way to inject clicks/keyboard at the
	// macOS login window but is typically held exclusively on modern macOS.
	// When unavailable we fall back to CGEvent posted to kCGSessionEventTap
	// which is the next-best option for login-window input injection.
	if rc := C.openHIDConnection(); rc == 0 {
		h.hidAvailable = true
		slog.Info("IOHIDSystem connection opened for login-window input support")
	} else {
		slog.Warn("IOHIDSystem unavailable — falling back to CGEvent session tap at login window",
			"rc", int(rc),
			"kernReturn", fmt.Sprintf("0x%x", int(C.hidLastKernReturn())))
	}

	// If launched in login_window context, start in login window mode.
	if desktopContext == "login_window" {
		h.atLoginWindow.Store(true)
	}

	return h
}

func (h *DarwinInputHandler) SetDisplayOffset(x, y int) {
	// macOS CGEvents use global display coordinates; offset handled by capturer.
}

// InputAvailable reports whether this handler can inject full input.
// At the login window we always attempt input, falling back from HID to
// CGEvent session tap when IOHIDSystem is unavailable.
func (h *DarwinInputHandler) InputAvailable() bool {
	return h.inputAvailable
}

func (h *DarwinInputHandler) SetAtLoginWindow(atLoginWindow bool) {
	prev := h.atLoginWindow.Swap(atLoginWindow)
	if prev != atLoginWindow {
		if atLoginWindow {
			slog.Info("input switching to IOHIDPostEvent mode (login window)")
		} else {
			slog.Info("input switching to CGEvent mode (user session)")
		}
	}
}

// shouldUseHID returns true when input should use IOHIDPostEvent.
func (h *DarwinInputHandler) shouldUseHID() bool {
	return h.atLoginWindow.Load() && h.hidAvailable
}

// shouldUseSessionTap returns true when input should use CGEvent posted to
// kCGSessionEventTap. This is the fallback path for login-window input when
// IOHIDSystem is unavailable (typical on modern macOS where WindowServer
// holds the exclusive IOHIDServerConnect). Session-tap events have a better
// chance of reaching the loginwindow input handler than HID-tap events.
func (h *DarwinInputHandler) shouldUseSessionTap() bool {
	return h.atLoginWindow.Load() && !h.hidAvailable
}

var errInputUnavailable = fmt.Errorf("input injection unavailable in login_window context (IOHIDSystem not connected)")

// scaleXY converts viewer coordinates (video pixel space, 2x on Retina)
// to macOS logical points that CGEvent expects.
func (h *DarwinInputHandler) scaleXY(x, y int) (C.int, C.int) {
	return C.int(float64(x) / h.scaleFactor), C.int(float64(y) / h.scaleFactor)
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

// cgTap is the cgMouse*/cgFlagsChanged tap argument: 1 for the session tap
// (login window without IOHIDSystem), else 0 for the HID tap.
func (h *DarwinInputHandler) cgTap() C.int {
	if h.shouldUseSessionTap() {
		return 1
	}
	return 0
}

// pointerFlags is the flags argument pair for a mouse event (W2c running mask;
// setFlags 0 with nothing held, as before).
func (h *DarwinInputHandler) pointerFlags() (C.int, C.int) {
	f, set := macPointerFlags(h.mods.flags())
	return C.int(f), boolToCInt(set)
}

func boolToCInt(b bool) C.int {
	if b {
		return 1
	}
	return 0
}

func (h *DarwinInputHandler) SendMouseMove(x, y int) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	sx, sy := h.scaleXY(x, y)
	f, set := h.pointerFlags()
	switch {
	case h.shouldUseHID():
		if h.mouseDown {
			C.hidMouseDrag(sx, sy, C.int(h.mouseBtn), f)
		} else {
			C.hidMouseMove(sx, sy, f)
		}
	case h.mouseDown:
		C.cgMouseDrag(h.cgTap(), sx, sy, C.int(h.mouseBtn), f, set)
	default:
		C.cgMouseMove(h.cgTap(), sx, sy, f, set)
	}
	return nil
}

func (h *DarwinInputHandler) SendMouseClick(x, y int, button string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	sx, sy := h.scaleXY(x, y)
	btn := C.int(macMouseButtonNumber(button))
	f, set := h.pointerFlags()
	if h.shouldUseHID() {
		C.hidMouseDown(sx, sy, btn, f)
		C.hidMouseUp(sx, sy, btn, f)
		return nil
	}
	C.cgMouseDown(h.cgTap(), sx, sy, btn, f, set)
	C.cgMouseUp(h.cgTap(), sx, sy, btn, f, set)
	return nil
}

func (h *DarwinInputHandler) SendMouseDown(x, y int, button string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	h.mouseBtn = macMouseButtonNumber(button)
	h.mouseDown = true
	sx, sy := h.scaleXY(x, y)
	f, set := h.pointerFlags()
	if h.shouldUseHID() {
		C.hidMouseDown(sx, sy, C.int(h.mouseBtn), f)
		return nil
	}
	C.cgMouseDown(h.cgTap(), sx, sy, C.int(h.mouseBtn), f, set)
	return nil
}

func (h *DarwinInputHandler) SendMouseUp(x, y int, button string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	h.mouseDown = false
	sx, sy := h.scaleXY(x, y)
	btn := C.int(macMouseButtonNumber(button))
	f, set := h.pointerFlags()
	if h.shouldUseHID() {
		C.hidMouseUp(sx, sy, btn, f)
		return nil
	}
	C.cgMouseUp(h.cgTap(), sx, sy, btn, f, set)
	return nil
}

func (h *DarwinInputHandler) SendMouseScroll(x, y int, delta int) error {
	return h.sendMouseScroll(x, y, delta, 0)
}

// sendMouseScroll posts the pre-W2c one-axis scroll when deltaX is 0, and a
// two-axis scroll for a W2c deltaX (macScrollFor has the signs).
func (h *DarwinInputHandler) sendMouseScroll(x, y, delta, deltaX int) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	sx, sy := h.scaleXY(x, y)
	sc := macScrollFor(delta, deltaX)
	f, set := h.pointerFlags()
	if h.shouldUseHID() {
		C.hidMouseMove(sx, sy, f)
		C.hidMouseScroll(C.int(sc.Wheel1), C.int(sc.Wheel2), f)
		return nil
	}
	C.cgMouseMove(h.cgTap(), sx, sy, f, set)
	C.cgMouseScroll(h.cgTap(), C.int(sc.Axes), C.int(sc.Wheel1), C.int(sc.Wheel2), f, set)
	return nil
}

func (h *DarwinInputHandler) SendKeyPress(key string, modifiers []string) error {
	return h.sendKeyPress(key, modifiers, nil)
}

// sendKeyPress is SendKeyPress plus the viewer's Caps Lock assertion. capsLock
// is nil for callers that have no state to assert (the exported interface
// method, the AI computer-use paths), and those behave exactly as before.
func (h *DarwinInputHandler) sendKeyPress(key string, modifiers []string, capsLock *bool) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	key = normalizeKeyName(key)
	if suppressCapsLockKey(key, capsLock) {
		return nil
	}
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	// modifiers is the COMPLETE modifier state the viewer wants for this key,
	// so the flags are set unconditionally (setFlags=1) — including to zero.
	// Leaving them alone when no modifier is requested lets a modifier still
	// held from an earlier event bleed in, which is the stuck-Shift uppercasing
	// of issue #4089. The IOHIDPostEvent path already passes flags on every
	// event, so it needs no equivalent.
	//
	// modifiersToFlags never carries AlphaShift, so without the fold below a
	// key_press would strip Caps Lock while a bare key_down (which inherits the
	// ambient flags) kept it — the inconsistent casing reported in #3595.
	//
	// W2c: modifiers the agent holds (h.mods) are part of that state too. The
	// K5 filter has already removed them from modifiers, so without the mask
	// a held Shift would be missing from Shift+A.
	rawFlags, _ := applyCapsLockFlag(int(modifiersToFlags(modifiers))|h.mods.flags(), capsLock)
	flags := C.int(rawFlags)
	switch {
	case h.shouldUseHID():
		C.hidKeyDown(C.int(keycode), flags)
		C.hidKeyUp(C.int(keycode), flags)
	case h.shouldUseSessionTap():
		C.sessionKeyDown(C.int(keycode), flags, 1)
		C.sessionKeyUp(C.int(keycode), flags, 1)
	default:
		C.inputKeyDown(C.int(keycode), flags, 1)
		C.inputKeyUp(C.int(keycode), flags, 1)
	}
	return nil
}

// darwinUnicodeChunkUnits is how many UTF-16 code units ride on one CGEvent.
// CGEventKeyboardSetUnicodeString takes a UniChar buffer and has no documented
// hard limit, but long buffers have historically been truncated by receivers, so
// a paste is delivered as a series of small events instead of one large one.
const darwinUnicodeChunkUnits = 20

// TypeText injects text literally via CGEventKeyboardSetUnicodeString, so the
// characters that arrive do not depend on the remote machine's keyboard layout
// (issue #4089). This is the primitive InjectText prefers.
func (h *DarwinInputHandler) TypeText(text string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	// IOHIDPostEvent cannot carry a Unicode string, so at the login window both
	// of its sub-cases fall through to the CGEvent session tap — the same tap
	// shouldUseSessionTap() already uses when IOHIDSystem is unavailable.
	useSessionTap := h.shouldUseHID() || h.shouldUseSessionTap()

	for _, chunk := range chunkUTF16(text, darwinUnicodeChunkUnits) {
		buf := (*C.UniChar)(unsafe.Pointer(&chunk[0]))
		if useSessionTap {
			C.sessionTypeUnicode(buf, C.int(len(chunk)))
		} else {
			C.inputTypeUnicode(buf, C.int(len(chunk)))
		}
	}
	return nil
}

// TypeChar satisfies TypeCharHandler for callers that type one character at a
// time (the AI computer-use "type" action).
func (h *DarwinInputHandler) TypeChar(ch rune) error {
	return h.TypeText(string(ch))
}

func (h *DarwinInputHandler) SendKeyDown(key string) error {
	return h.sendKeyDown(key, nil)
}

func (h *DarwinInputHandler) sendKeyDown(key string, capsLock *bool) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	key = normalizeKeyName(key)
	if suppressCapsLockKey(key, capsLock) {
		return nil
	}
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	rawFlags, set := macKeyFlags(h.mods.flags(), capsLock)
	flags, setFlags := rawFlags, boolToCInt(set)
	switch {
	case h.shouldUseHID():
		C.hidKeyDown(C.int(keycode), C.int(flags))
	case h.shouldUseSessionTap():
		C.sessionKeyDown(C.int(keycode), C.int(flags), setFlags)
	default:
		C.inputKeyDown(C.int(keycode), C.int(flags), setFlags)
	}
	return nil
}

func (h *DarwinInputHandler) SendKeyUp(key string) error {
	return h.sendKeyUp(key, nil)
}

func (h *DarwinInputHandler) sendKeyUp(key string, capsLock *bool) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	key = normalizeKeyName(key)
	if suppressCapsLockKey(key, capsLock) {
		return nil
	}
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	rawFlags, set := macKeyFlags(h.mods.flags(), capsLock)
	flags, setFlags := rawFlags, boolToCInt(set)
	switch {
	case h.shouldUseHID():
		C.hidKeyUp(C.int(keycode), C.int(flags))
	case h.shouldUseSessionTap():
		C.sessionKeyUp(C.int(keycode), C.int(flags), setFlags)
	default:
		C.inputKeyUp(C.int(keycode), C.int(flags), setFlags)
	}
	return nil
}

// handleModifierKey is the W2c modifier path for key_down/key_up. A modifier
// key_down in a sequenced session (seq > 0) is held: its bit joins h.mods and
// a kCGEventFlagsChanged is posted. A modifier key_up for a held modifier
// clears the bit, whatever its seq, so ReleaseAll's releases (seq 0) clear
// the mask. handled is false for everything else, which keeps the pre-W2c
// path: a legacy modifier key_down is still rejected as an unknown key, so
// legacy sessions never hold a modifier.
func (h *DarwinInputHandler) handleModifierKey(event InputEvent) (handled bool) {
	var keycode int
	switch event.Type {
	case "key_down":
		if event.Seq == 0 {
			return false
		}
		kc, ok := h.mods.press(event.Key, event.Code)
		if !ok {
			return false
		}
		keycode = kc
	case "key_up":
		kc, ok := h.mods.release(event.Key, event.Code)
		if !ok {
			return false
		}
		keycode = kc
	default:
		return false
	}
	flags := C.int(h.mods.flags())
	if h.shouldUseHID() {
		C.hidFlagsChanged(C.int(keycode), flags)
	} else {
		C.cgFlagsChanged(h.cgTap(), C.int(keycode), flags)
	}
	return true
}

func (h *DarwinInputHandler) HandleEvent(event InputEvent) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
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
	case "key_press":
		return h.sendKeyPress(event.Key, event.Modifiers, event.CapsLock)
	case "key_down":
		if h.handleModifierKey(event) {
			return nil
		}
		return h.sendKeyDown(event.Key, event.CapsLock)
	case "key_up":
		if h.handleModifierKey(event) {
			return nil
		}
		return h.sendKeyUp(event.Key, event.CapsLock)
	default:
		return fmt.Errorf("unknown event type: %s", event.Type)
	}
}
