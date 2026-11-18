//go:build !windows

// Not on Windows: handleDesktopSwitch's secure-desktop branch nudges the real
// cursor and repaints the real desktop there. Elsewhere those are no-ops.

package desktop

import (
	"image"
	"testing"
	"time"
)

// switchingCapturer reports one pending desktop switch onto a secure desktop.
type switchingCapturer struct {
	staticTestCapturer
	switched bool
}

func (c *switchingCapturer) ConsumeDesktopSwitch() bool {
	if c.switched {
		return false
	}
	c.switched = true
	return true
}

func (c *switchingCapturer) OnSecureDesktop() bool { return true }

func TestHandleDesktopSwitchReleasesHeldInput(t *testing.T) {
	inner := &workerRecorder{}
	si := NewSafeInput(inner, "s")
	t.Cleanup(si.Close)
	s := &Session{
		id:           "s",
		inputHandler: si,
		capturer:     &switchingCapturer{staticTestCapturer: staticTestCapturer{img: image.NewRGBA(image.Rect(0, 0, 4, 4))}},
	}
	if err := si.HandleEvent(InputEvent{Type: "key_down", Key: "alt"}); err != nil {
		t.Fatal(err)
	}

	s.handleDesktopSwitch()

	for _, c := range inner.snapshot() {
		if c == "key_up:alt" {
			return
		}
	}
	t.Fatalf("desktop switch did not release alt: %v", inner.snapshot())
}

// R3: a desktop switch changes the input offset, so it is a geometry transition.
func TestHandleDesktopSwitchMovesTheGeometryEpoch(t *testing.T) {
	si := NewSafeInput(&workerRecorder{}, "s")
	t.Cleanup(si.Close)
	s := &Session{
		id:           "s",
		inputHandler: si,
		capturer:     &switchingCapturer{staticTestCapturer: staticTestCapturer{img: image.NewRGBA(image.Rect(0, 0, 4, 4))}},
	}

	s.handleDesktopSwitch()

	if r, g := si.Epochs(); r != 2 || g != 2 {
		t.Fatalf("Epochs() after a desktop switch = %d,%d want 2,2", r, g)
	}
}

// resizedSwitchCapturer reports one pending switch back to the Default
// desktop, after which DXGI re-read a new display mode (#11754).
type resizedSwitchCapturer struct {
	resizingCapturer
	switched bool
}

func (c *resizedSwitchCapturer) ConsumeDesktopSwitch() bool {
	if c.switched {
		return false
	}
	c.switched = true
	return true
}

func (c *resizedSwitchCapturer) OnSecureDesktop() bool { return false }

// #11754: a desktop switch that lands on a new display mode (how a DXGI
// re-init after a mode change arrives) is one geometry transition, not two.
// The switch moves the epoch and announces the monitor as a resolution change
// (so the viewer holds pointer input); the capture path only resizes the
// encoder.
func TestDesktopSwitchWithNewModeIsOneTransition(t *testing.T) {
	announced := recordAnnouncements(t)
	s, _, stub, si := newGeometryTestSession(t, 1920, 1080, "mft")
	cap := &resizedSwitchCapturer{resizingCapturer: resizingCapturer{w: 1920, h: 1080}}
	s.capturer = cap
	s.captureW, s.captureH = 1920, 1080
	_, geoBefore := si.Epochs()

	cap.setSize(2560, 1600)
	s.handleDesktopSwitch()
	s.captureAndSendFrame(16 * time.Millisecond)

	if _, geo := si.Epochs(); geo != geoBefore+1 {
		t.Fatalf("geometry epoch %d -> %d, want exactly one transition", geoBefore, geo)
	}
	got := announced()
	if len(got) != 1 {
		t.Fatalf("announcements = %v, want exactly one (the desktop switch's)", got)
	}
	if got[0]["reason"] != "resolution_change" || got[0]["width"] != 2560 || got[0]["height"] != 1600 {
		t.Fatalf("desktop-switch announcement = %v, want a resolution_change at 2560x1600", got[0])
	}
	if w, h, _, encodes, _ := stub.snapshot(); w != 2560 || h != 1600 || encodes != 1 {
		t.Fatalf("encoder %dx%d encodes %d after the switch; want 2560x1600 and the frame encoded", w, h, encodes)
	}
}

// A desktop switch at an unchanged size is announced as before: no reason, so
// the viewer does not hold input.
func TestDesktopSwitchAtSameSizeIsNotAResolutionChange(t *testing.T) {
	announced := recordAnnouncements(t)
	s, _, _, _ := newGeometryTestSession(t, 1920, 1080, "mft")
	cap := &resizedSwitchCapturer{resizingCapturer: resizingCapturer{w: 1920, h: 1080}}
	s.capturer = cap
	s.captureW, s.captureH = 1920, 1080

	s.handleDesktopSwitch()

	got := announced()
	if len(got) != 1 {
		t.Fatalf("announcements = %v, want one", got)
	}
	if _, has := got[0]["reason"]; has {
		t.Fatalf("a same-size desktop switch carried a reason: %v", got[0])
	}
}
