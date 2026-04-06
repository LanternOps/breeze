//go:build windows

package desktop

import "testing"

func TestAMF_FactoryRegistered(t *testing.T) {
	hardwareFactoriesMu.Lock()
	found := false
	for _, tf := range hardwareFactories {
		if tf.vendor == "amd" {
			found = true
			break
		}
	}
	hardwareFactoriesMu.Unlock()
	if !found {
		t.Error("AMF factory not registered with vendor tag 'amd'")
	}
}

func TestAMF_GracefulFailureOnNonAMD(t *testing.T) {
	cfg := EncoderConfig{Codec: CodecH264, PreferHardware: true}
	enc, err := newAMFEncoder(cfg)
	if err == nil && enc != nil {
		enc.Close()
		t.Skip("AMD GPU present, skipping non-AMD failure test")
	}
	if err == nil {
		t.Error("expected error on non-AMD machine, got nil")
	}
	t.Logf("graceful failure: %v", err)
}

func TestAMF_RejectsNonH264(t *testing.T) {
	_, err := newAMFEncoder(EncoderConfig{Codec: CodecVP9})
	if err == nil {
		t.Error("expected error for VP9 codec, got nil")
	}
	_, err = newAMFEncoder(EncoderConfig{Codec: CodecAV1})
	if err == nil {
		t.Error("expected error for AV1 codec, got nil")
	}
}

func TestAMF_SupportsGPUInputRequiresDevice(t *testing.T) {
	enc := &amfEncoder{}
	if enc.SupportsGPUInput() {
		t.Error("SupportsGPUInput should be false without D3D11 device")
	}
	enc.d3d11Device = 0xDEADBEEF
	if !enc.SupportsGPUInput() {
		t.Error("SupportsGPUInput should be true with D3D11 device")
	}
}

func TestAMF_CPUEncodeReturnsError(t *testing.T) {
	enc := &amfEncoder{}
	_, err := enc.Encode([]byte{1, 2, 3})
	if err == nil {
		t.Error("expected error from CPU Encode path")
	}
}

func TestAMF_ForceKeyframe(t *testing.T) {
	enc := &amfEncoder{}
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

func TestAMF_SetDimensionsEven(t *testing.T) {
	enc := &amfEncoder{}
	enc.SetDimensions(1921, 1081)
	if enc.width != 1920 || enc.height != 1080 {
		t.Errorf("expected 1920x1080, got %dx%d", enc.width, enc.height)
	}
}

func TestAMF_VariantSizes(t *testing.T) {
	v := amfVariantInt64(42)
	if v.VarType != amfVarInt64 {
		t.Errorf("expected type %d, got %d", amfVarInt64, v.VarType)
	}

	vb := amfVariantBool(true)
	if vb.VarType != amfVarBool {
		t.Errorf("expected type %d, got %d", amfVarBool, vb.VarType)
	}

	vr := amfVariantRate(60, 1)
	if vr.VarType != amfVarRate {
		t.Errorf("expected type %d, got %d", amfVarRate, vr.VarType)
	}
}
