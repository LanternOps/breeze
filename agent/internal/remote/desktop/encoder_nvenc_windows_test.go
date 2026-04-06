//go:build windows

package desktop

import "testing"

func TestNVENC_FactoryRegistered(t *testing.T) {
	hardwareFactoriesMu.Lock()
	found := false
	for _, tf := range hardwareFactories {
		if tf.vendor == "nvidia" {
			found = true
			break
		}
	}
	hardwareFactoriesMu.Unlock()
	if !found {
		t.Error("NVENC factory not registered with vendor tag 'nvidia'")
	}
}

func TestNVENC_GracefulFailureOnNonNVIDIA(t *testing.T) {
	cfg := EncoderConfig{Codec: CodecH264, PreferHardware: true}
	enc, err := newNVENCEncoder(cfg)
	if err == nil && enc != nil {
		// NVIDIA GPU present and DLL loaded — skip this test
		enc.Close()
		t.Skip("NVIDIA GPU present, skipping non-NVIDIA failure test")
	}
	if err == nil {
		t.Error("expected error on non-NVIDIA machine, got nil")
	}
	t.Logf("graceful failure: %v", err)
}

func TestNVENC_RejectsNonH264(t *testing.T) {
	_, err := newNVENCEncoder(EncoderConfig{Codec: CodecVP9})
	if err == nil {
		t.Error("expected error for VP9 codec, got nil")
	}
	_, err = newNVENCEncoder(EncoderConfig{Codec: CodecAV1})
	if err == nil {
		t.Error("expected error for AV1 codec, got nil")
	}
}

func TestNVENC_SupportsGPUInputRequiresDevice(t *testing.T) {
	enc := &nvencEncoder{}
	if enc.SupportsGPUInput() {
		t.Error("SupportsGPUInput should be false without D3D11 device")
	}
	enc.d3d11Device = 0xDEADBEEF
	if !enc.SupportsGPUInput() {
		t.Error("SupportsGPUInput should be true with D3D11 device")
	}
}

func TestNVENC_CPUEncodeReturnsError(t *testing.T) {
	enc := &nvencEncoder{}
	_, err := enc.Encode([]byte{1, 2, 3})
	if err == nil {
		t.Error("expected error from CPU Encode path")
	}
}

func TestNVENC_ForceKeyframe(t *testing.T) {
	enc := &nvencEncoder{}
	if enc.forceIDR {
		t.Error("forceIDR should start false")
	}
	if err := enc.ForceKeyframe(); err != nil {
		t.Errorf("ForceKeyframe failed: %v", err)
	}
	if !enc.forceIDR {
		t.Error("forceIDR should be true after ForceKeyframe")
	}
}

func TestNVENC_SetDimensionsEven(t *testing.T) {
	enc := &nvencEncoder{}
	enc.SetDimensions(1921, 1081)
	if enc.width != 1920 || enc.height != 1080 {
		t.Errorf("expected 1920x1080, got %dx%d", enc.width, enc.height)
	}
}
