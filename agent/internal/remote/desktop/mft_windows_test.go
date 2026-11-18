//go:build windows

package desktop

import "testing"

// #11392: without this registration StartSession has no fallback when
// OpenH264 cannot load and refuses every session that starts on Winlogon.
func TestMFTRegistersPlaceholderFallback(t *testing.T) {
	placeholderFallbackMu.Lock()
	defer placeholderFallbackMu.Unlock()
	if placeholderFallbackFactory == nil {
		t.Fatal("Windows must register the Media Foundation placeholder fallback")
	}
	if placeholderFallbackLabel != "Media Foundation" {
		t.Fatalf("fallback label = %q, want Media Foundation", placeholderFallbackLabel)
	}
}

func TestMFTPlaceholderFallbackRejectsNonH264(t *testing.T) {
	if _, err := newMFTPlaceholderFallbackEncoder(EncoderConfig{Codec: CodecVP9}); err == nil {
		t.Fatal("fallback accepted VP9, want error")
	}
}
