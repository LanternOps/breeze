//go:build linux

package wayland

import (
	"errors"
	"image"
	"io"
	"strings"
	"testing"
)

func TestCaptureErrorsAfterShareStops(t *testing.T) {
	p := &pipe{
		frame: image.NewRGBA(image.Rect(0, 0, 2, 2)),
		ready: make(chan struct{}),
	}
	close(p.ready)
	c := &Capturer{p: p}
	if _, err := c.Capture(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.GetScreenBounds(); err != nil {
		t.Fatal(err)
	}

	p.noteStreamEnd(io.EOF)
	_, err := c.Capture()
	if !errors.Is(err, ErrShareStopped) {
		t.Fatalf("capture: %v", err)
	}
	if _, _, err := c.GetScreenBounds(); !errors.Is(err, ErrShareStopped) {
		t.Fatalf("bounds: %v", err)
	}
	if !errors.Is(c.LastCaptureError(), ErrShareStopped) {
		t.Fatalf("last error: %v", c.LastCaptureError())
	}
}

func TestStreamEndBeforeFrameIsNotShareStopped(t *testing.T) {
	p := &pipe{ready: make(chan struct{})}
	p.detail = "wayland-capture: portal missing"
	p.noteStreamEnd(io.EOF)
	p.mu.Lock()
	err := p.fail
	p.mu.Unlock()
	if errors.Is(err, ErrShareStopped) || err == nil || !strings.Contains(err.Error(), "portal missing") {
		t.Fatalf("got %v", err)
	}
}

func TestKeyUsesX11Keysym(t *testing.T) {
	for _, name := range []string{"!", "@", "?", ":", "é"} {
		err := Key(name, true)
		if err == nil || strings.Contains(err.Error(), "unknown key") {
			t.Fatalf("%q: %v", name, err)
		}
	}
	err := Key("not-a-key", true)
	if err == nil || !strings.Contains(err.Error(), "unknown key") {
		t.Fatalf("unknown key: %v", err)
	}
}
