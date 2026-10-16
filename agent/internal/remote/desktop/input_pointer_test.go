package desktop

import (
	"reflect"
	"testing"
)

func TestWinMouseButtonLegacyUnchanged(t *testing.T) {
	cases := []struct {
		button   string
		down, up uint32
	}{
		{"left", winMouseeventfLeftDown, winMouseeventfLeftUp},
		{"", winMouseeventfLeftDown, winMouseeventfLeftUp},
		{"right", winMouseeventfRightDown, winMouseeventfRightUp},
		{"middle", winMouseeventfMiddleDown, winMouseeventfMiddleUp},
	}
	for _, tc := range cases {
		got := winMouseButtonFor(tc.button)
		want := winMouseButton{Down: tc.down, Up: tc.up}
		if got != want {
			t.Fatalf("%q: got %+v, want %+v", tc.button, got, want)
		}
	}
}

// Before W2c the Windows switch fell through to LEFTDOWN/LEFTUP for anything
// unrecognised, so a thumb button clicked (spec M1). back/forward are now X
// buttons, and the up resolves to the same X button as the down.
func TestWinMouseButtonBackForward(t *testing.T) {
	back := winMouseButtonFor("back")
	if back != (winMouseButton{Down: winMouseeventfXDown, Up: winMouseeventfXUp, Data: winXButton1}) {
		t.Fatalf("back = %+v", back)
	}
	fwd := winMouseButtonFor("Forward")
	if fwd != (winMouseButton{Down: winMouseeventfXDown, Up: winMouseeventfXUp, Data: winXButton2}) {
		t.Fatalf("forward = %+v", fwd)
	}
}

func TestWinScrollLegacyUnchanged(t *testing.T) {
	// Exactly one WHEEL event with mouseData = -delta*120, including delta 0.
	for _, d := range []int{-3, -1, 0, 1, 120} {
		got := winScrollInputs(d, 0)
		want := []winMouseWheel{{Flags: winMouseeventfWheel, Data: uint32(-d * 120)}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("delta %d: got %+v, want %+v", d, got, want)
		}
	}
}

func TestWinScrollHorizontal(t *testing.T) {
	// HWHEEL positive = right, the same sign as the viewer's deltaX.
	got := winScrollInputs(0, 2)
	want := []winMouseWheel{{Flags: winMouseeventfHWheel, Data: uint32(2 * 120)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("deltaX only: got %+v, want %+v", got, want)
	}
	got = winScrollInputs(1, -1)
	want = []winMouseWheel{
		{Flags: winMouseeventfWheel, Data: wheelData(-1)},
		{Flags: winMouseeventfHWheel, Data: wheelData(-1)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("both axes: got %+v, want %+v", got, want)
	}
}

func TestMacMouseButtonNumber(t *testing.T) {
	cases := map[string]int{"": 0, "left": 0, "right": 1, "middle": 2, "back": 3, "Forward": 4, "bogus": 0}
	for b, want := range cases {
		if got := macMouseButtonNumber(b); got != want {
			t.Fatalf("%q: got %d, want %d", b, got, want)
		}
	}
}

func TestMacScrollAxes(t *testing.T) {
	// Legacy: one axis, negated (browser deltaY+ = down, CG wheel1+ = up).
	if got := macScrollFor(3, 0); got != (macScroll{Axes: 1, Wheel1: -3}) {
		t.Fatalf("legacy: %+v", got)
	}
	if got := macScrollFor(0, 0); got != (macScroll{Axes: 1, Wheel1: 0}) {
		t.Fatalf("legacy zero: %+v", got)
	}
	// CG wheel2 positive scrolls left, so deltaX (positive = right) is negated.
	if got := macScrollFor(0, 2); got != (macScroll{Axes: 2, Wheel1: 0, Wheel2: -2}) {
		t.Fatalf("horizontal: %+v", got)
	}
	if got := macScrollFor(-1, -4); got != (macScroll{Axes: 2, Wheel1: 1, Wheel2: 4}) {
		t.Fatalf("both: %+v", got)
	}
}

func TestX11ButtonCode(t *testing.T) {
	cases := map[string]byte{"": 1, "left": 1, "middle": 2, "right": 3, "back": 8, "forward": 9, "Back": 8, "bogus": 1}
	for b, want := range cases {
		if got := x11ButtonCode(b); got != want {
			t.Fatalf("%q: got %d, want %d", b, got, want)
		}
	}
}

func TestX11ScrollLegacyUnchanged(t *testing.T) {
	// Before W2c: button 4 repeated delta times for delta >= 0, button 5 for
	// delta < 0 (and nothing for 0).
	cases := []struct {
		delta int
		want  []x11ScrollClick
	}{
		{3, []x11ScrollClick{{Button: 4, Count: 3}}},
		{-2, []x11ScrollClick{{Button: 5, Count: 2}}},
		{0, nil},
	}
	for _, tc := range cases {
		if got := x11ScrollClicksFor(tc.delta, 0); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("delta %d: got %+v, want %+v", tc.delta, got, tc.want)
		}
	}
}

func TestX11ScrollHorizontal(t *testing.T) {
	if got := x11ScrollClicksFor(0, 2); !reflect.DeepEqual(got, []x11ScrollClick{{Button: 7, Count: 2}}) {
		t.Fatalf("right: %+v", got)
	}
	if got := x11ScrollClicksFor(0, -3); !reflect.DeepEqual(got, []x11ScrollClick{{Button: 6, Count: 3}}) {
		t.Fatalf("left: %+v", got)
	}
	want := []x11ScrollClick{{Button: 5, Count: 1}, {Button: 7, Count: 1}}
	if got := x11ScrollClicksFor(-1, 1); !reflect.DeepEqual(got, want) {
		t.Fatalf("both: %+v, want %+v", got, want)
	}
}

// wheelData is a signed wheel amount as MOUSEINPUT.mouseData carries it.
func wheelData(steps int) uint32 { return uint32(steps * 120) }
