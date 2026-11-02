//go:build darwin && cgo
// +build darwin,cgo

package desktop

import (
	"strings"
	"testing"
)

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

// TestVideoToolboxWarmUpLive runs the #10880 restore warm-up against the real
// VideoToolbox encoder: a working encoder must return a frame well inside the
// budget and come back ready to swap in. Skips where no compression session can
// be created at all (e.g. a headless VM).
func TestVideoToolboxWarmUpLive(t *testing.T) {
	enc, err := NewVideoEncoder(EncoderConfig{Codec: CodecH264, Quality: QualityAuto, Bitrate: 1_000_000, FPS: 30, PreferHardware: true})
	if err != nil {
		t.Fatalf("NewVideoEncoder: %v", err)
	}
	if enc.BackendName() != "videotoolbox" {
		enc.Close()
		t.Skipf("hardware factory picked %q, not videotoolbox", enc.BackendName())
	}
	res := warmUpHardwareEncoder(enc, 320, 240, PixelFormatBGRA, hardwareWarmupBudget, hardwareWarmupRetryGap, make(chan struct{}))
	if res.err != nil {
		if strings.Contains(res.err.Error(), "create session failed") {
			t.Skipf("no VideoToolbox session on this host: %v", res.err)
		}
		t.Fatalf("warm-up of a working VideoToolbox encoder failed: %v", res.err)
	}
	defer res.enc.Close()
	if res.frames < 1 {
		t.Fatalf("expected at least one warm-up encode, got %d", res.frames)
	}
	// The queued keyframe must make the first live frame an IDR.
	data, err := res.enc.Encode(make([]byte, 320*240*4))
	if err != nil || len(data) == 0 {
		t.Fatalf("first post-warm-up encode: data=%d err=%v", len(data), err)
	}
	if !h264ContainsIDR(data) {
		t.Fatalf("first frame after warm-up must be an IDR")
	}
}
