//go:build windows && !cgo

package desktop

import "testing"

// #12624: while CaptureTexture's frame is still held, Capture() must report
// "no frame" without touching DXGI. AcquireNextFrame there would return
// DXGI_ERROR_INVALID_CALL, which Capture() otherwise answers by tearing the
// device down under the encoder. The guard runs before anything else, so a
// capturer with no DXGI state at all is enough: reaching any later step would
// fail ("not initialized") or touch a nil COM pointer.
func TestDXGICaptureReturnsNoFrameWhileTextureHeld(t *testing.T) {
	c := &dxgiCapturer{textureFrameAcquired: true}
	img, err := c.Capture()
	if img != nil || err != nil {
		t.Fatalf("Capture() = (%v, %v) with a texture frame held, want (nil, nil)", img, err)
	}
	if !c.textureFrameAcquired {
		t.Fatal("Capture() released the held texture frame")
	}
}
