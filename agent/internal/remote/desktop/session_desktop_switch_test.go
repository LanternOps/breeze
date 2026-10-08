//go:build !windows

// Not on Windows: handleDesktopSwitch's secure-desktop branch nudges the real
// cursor and repaints the real desktop there. Elsewhere those are no-ops.

package desktop

import (
	"image"
	"testing"
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
