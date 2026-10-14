package desktop

import "strings"

// Pointer mapping for the three platform handlers, untagged so it is
// unit-tested on every OS. The platform files only post what these return.
//
// Every function here reproduces the pre-W2c output exactly when the W2c
// fields are absent (button left/right/middle/"", deltaX 0); see the Legacy
// tests in input_pointer_test.go.

func normalizeButton(button string) string {
	return strings.ToLower(strings.TrimSpace(button))
}

// ---- Windows (SendInput MOUSEINPUT) ----

// MOUSEEVENTF_* and XBUTTON* values (WinUser.h).
const (
	winMouseeventfLeftDown   = 0x0002
	winMouseeventfLeftUp     = 0x0004
	winMouseeventfRightDown  = 0x0008
	winMouseeventfRightUp    = 0x0010
	winMouseeventfMiddleDown = 0x0020
	winMouseeventfMiddleUp   = 0x0040
	winMouseeventfXDown      = 0x0080
	winMouseeventfXUp        = 0x0100
	winMouseeventfWheel      = 0x0800
	winMouseeventfHWheel     = 0x1000

	winXButton1 = 0x0001 // back
	winXButton2 = 0x0002 // forward

	winWheelDelta = 120
)

// winMouseButton is the dwFlags for press and release plus the mouseData an
// X button needs (zero for the others).
type winMouseButton struct {
	Down, Up uint32
	Data     uint32
}

// winMouseButtonFor maps a viewer button. Anything unrecognised is left, as
// before W2c.
func winMouseButtonFor(button string) winMouseButton {
	switch normalizeButton(button) {
	case "right":
		return winMouseButton{Down: winMouseeventfRightDown, Up: winMouseeventfRightUp}
	case "middle":
		return winMouseButton{Down: winMouseeventfMiddleDown, Up: winMouseeventfMiddleUp}
	case "back":
		return winMouseButton{Down: winMouseeventfXDown, Up: winMouseeventfXUp, Data: winXButton1}
	case "forward":
		return winMouseButton{Down: winMouseeventfXDown, Up: winMouseeventfXUp, Data: winXButton2}
	default:
		return winMouseButton{Down: winMouseeventfLeftDown, Up: winMouseeventfLeftUp}
	}
}

// winMouseWheel is one wheel MOUSEINPUT.
type winMouseWheel struct {
	Flags uint32
	Data  uint32
}

// winScrollInputs returns the wheel events for one mouse_scroll. Without
// deltaX it is the single pre-W2c WHEEL event (sent even for delta 0). With
// deltaX, the vertical event is sent only when delta is non-zero, followed by
// an HWHEEL. Vertical is negated (browser deltaY+ = down, WHEEL+ = up);
// horizontal is not (deltaX+ = right, HWHEEL+ = right).
func winScrollInputs(delta, deltaX int) []winMouseWheel {
	if deltaX == 0 {
		return []winMouseWheel{{Flags: winMouseeventfWheel, Data: uint32(-delta * winWheelDelta)}}
	}
	out := make([]winMouseWheel, 0, 2)
	if delta != 0 {
		out = append(out, winMouseWheel{Flags: winMouseeventfWheel, Data: uint32(-delta * winWheelDelta)})
	}
	return append(out, winMouseWheel{Flags: winMouseeventfHWheel, Data: uint32(deltaX * winWheelDelta)})
}

// ---- macOS (CGEvent / IOHIDPostEvent) ----

// macMouseButtonNumber is the CGMouseButton: 0 left, 1 right, 2 center, and
// for W2c 3 (back) and 4 (forward), which macOS reports as other-mouse
// buttons. Anything unrecognised is left, as before.
func macMouseButtonNumber(button string) int {
	switch normalizeButton(button) {
	case "right":
		return 1
	case "middle":
		return 2
	case "back":
		return 3
	case "forward":
		return 4
	default:
		return 0
	}
}

// macScroll is the CGEventCreateScrollWheelEvent wheel count and values.
type macScroll struct {
	Axes   int
	Wheel1 int // vertical, positive = up
	Wheel2 int // horizontal, positive = left
}

// macScrollFor keeps the pre-W2c one-axis event when deltaX is 0. Both axes
// are negated: browser deltaY+ = down and deltaX+ = right, while CG wheel1+
// is up and wheel2+ is left.
func macScrollFor(delta, deltaX int) macScroll {
	if deltaX == 0 {
		return macScroll{Axes: 1, Wheel1: -delta}
	}
	return macScroll{Axes: 2, Wheel1: -delta, Wheel2: -deltaX}
}

// ---- X11 (XTEST) ----

// x11ButtonCode is the core-protocol button: 1 left, 2 middle, 3 right, and
// for W2c 8 (back) and 9 (forward). Anything unrecognised is left.
func x11ButtonCode(button string) byte {
	switch normalizeButton(button) {
	case "right":
		return 3
	case "middle":
		return 2
	case "back":
		return 8
	case "forward":
		return 9
	default:
		return 1
	}
}

// XTEST scroll buttons.
const (
	x11ScrollUp    byte = 4
	x11ScrollDown  byte = 5
	x11ScrollLeft  byte = 6
	x11ScrollRight byte = 7
)

// x11ScrollClick is one scroll button clicked Count times.
type x11ScrollClick struct {
	Button byte
	Count  int
}

// x11ScrollClicksFor returns the button clicks for one mouse_scroll. The
// vertical mapping is the pre-W2c one, unchanged (button 4 for delta > 0).
// deltaX > 0 scrolls right (button 7), < 0 left (button 6).
func x11ScrollClicksFor(delta, deltaX int) []x11ScrollClick {
	var out []x11ScrollClick
	switch {
	case delta > 0:
		out = append(out, x11ScrollClick{Button: x11ScrollUp, Count: delta})
	case delta < 0:
		out = append(out, x11ScrollClick{Button: x11ScrollDown, Count: -delta})
	}
	switch {
	case deltaX > 0:
		out = append(out, x11ScrollClick{Button: x11ScrollRight, Count: deltaX})
	case deltaX < 0:
		out = append(out, x11ScrollClick{Button: x11ScrollLeft, Count: -deltaX})
	}
	return out
}
