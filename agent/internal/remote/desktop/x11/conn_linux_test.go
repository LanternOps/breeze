//go:build linux

package x11

import (
	"os"
	"testing"
)

// probeTarget returns a real display target from the environment, or skips.
func probeTarget(t *testing.T) DisplayTarget {
	t.Helper()
	target, err := SelectX11Target()
	if err != nil {
		if d := os.Getenv("DISPLAY"); d != "" {
			return DisplayTarget{Display: d, XauthPath: os.Getenv("XAUTHORITY"), SessionType: "x11"}
		}
		t.Skipf("no X11 display available: %v", err)
	}
	return target
}

func TestOpenAndCapture(t *testing.T) {
	target := probeTarget(t)
	c, err := Open(target)
	if err != nil {
		t.Skipf("cannot open X display %s: %v", target.Display, err)
	}
	defer func() { _ = c.Close() }()
	w, h := c.Bounds()
	if w <= 0 || h <= 0 {
		t.Fatalf("bad bounds %dx%d", w, h)
	}
	pix, gw, gh, err := c.CaptureBGRX()
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if len(pix) < gw*gh*4 {
		t.Fatalf("short frame: len=%d want>=%d", len(pix), gw*gh*4)
	}
}
