//go:build darwin && cgo
// +build darwin,cgo

package desktop

import "testing"

// TestVideoToolboxImplementsKeyframeForcer guards the RTCP PLI path: if this
// assertion regresses, ForceKeyframe on macOS silently becomes a no-op again.
func TestVideoToolboxImplementsKeyframeForcer(t *testing.T) {
	var enc encoderBackend = &videotoolboxEncoder{}
	kf, ok := enc.(optionalKeyframeForcer)
	if !ok {
		t.Fatalf("videotoolboxEncoder does not implement optionalKeyframeForcer")
	}
	if err := kf.ForceKeyframe(); err != nil {
		t.Fatalf("ForceKeyframe returned error: %v", err)
	}
	// Flag should be set; we can read it without the session being initialized.
	v := enc.(*videotoolboxEncoder)
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.forceIDR {
		t.Fatalf("expected forceIDR=true after ForceKeyframe, got false")
	}
}
