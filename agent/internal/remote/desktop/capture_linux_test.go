//go:build linux

package desktop

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

func TestLinuxCapturerImplementsInterfaces(t *testing.T) {
	var c ScreenCapturer = &linuxCapturer{}
	if _, ok := c.(BGRAProvider); !ok {
		t.Error("linuxCapturer must implement BGRAProvider")
	}
	if _, ok := c.(CursorProvider); !ok {
		t.Error("linuxCapturer must implement CursorProvider")
	}
	if _, ok := c.(CursorShapeProvider); !ok {
		t.Error("linuxCapturer must implement CursorShapeProvider")
	}
}

func TestLinuxCapturerCaptureIfDisplay(t *testing.T) {
	if _, err := x11.SelectX11Target(); err != nil {
		t.Skipf("no X display: %v", err)
	}
	cap, err := newPlatformCapturer(DefaultConfig())
	if err != nil {
		t.Skipf("cannot create capturer: %v", err)
	}
	defer func() { _ = cap.Close() }()
	img, err := cap.Capture()
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if img.Bounds().Dx() == 0 {
		t.Fatal("zero-width frame")
	}
	if bgra, ok := cap.(BGRAProvider); !ok || !bgra.IsBGRA() {
		t.Fatal("linux capturer should report BGRA")
	}
}
