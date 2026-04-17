package desktop

import (
	"bytes"
	"testing"
)

// H.264 Annex B NAL units. Each buffer starts with 00 00 00 01; the 5th byte's
// low 5 bits are the nal_unit_type. Type 5 = IDR, type 1 = non-IDR P-frame.
var (
	idrNALU    = []byte{0x00, 0x00, 0x00, 0x01, 0x65, 0xDE, 0xAD, 0xBE, 0xEF}
	pFrameNALU = []byte{0x00, 0x00, 0x00, 0x01, 0x41, 0xCA, 0xFE, 0xBA, 0xBE}
)

func TestCacheEncodedFrame_TracksIDRSeparately(t *testing.T) {
	s := &Session{}

	// P-frame first — no IDR should be cached yet.
	s.cacheEncodedFrame(pFrameNALU)
	s.lastEncodedMu.RLock()
	if len(s.lastEncodedFrame) == 0 {
		s.lastEncodedMu.RUnlock()
		t.Fatalf("lastEncodedFrame should hold the P-frame")
	}
	if len(s.lastEncodedIDR) != 0 {
		s.lastEncodedMu.RUnlock()
		t.Fatalf("lastEncodedIDR should be empty before any IDR is cached")
	}
	s.lastEncodedMu.RUnlock()

	// IDR — both slots should hold the IDR bytes.
	s.cacheEncodedFrame(idrNALU)
	s.lastEncodedMu.RLock()
	if !bytes.Equal(s.lastEncodedFrame, idrNALU) {
		s.lastEncodedMu.RUnlock()
		t.Fatalf("lastEncodedFrame should mirror the latest encoded frame")
	}
	if !bytes.Equal(s.lastEncodedIDR, idrNALU) {
		s.lastEncodedMu.RUnlock()
		t.Fatalf("lastEncodedIDR should capture the IDR payload")
	}
	s.lastEncodedMu.RUnlock()

	// Another P-frame — latest frame updates, but the IDR cache must stick so
	// idle resends have a standalone-decodable payload to emit.
	s.cacheEncodedFrame(pFrameNALU)
	s.lastEncodedMu.RLock()
	defer s.lastEncodedMu.RUnlock()
	if !bytes.Equal(s.lastEncodedFrame, pFrameNALU) {
		t.Fatalf("lastEncodedFrame should track the most recent frame")
	}
	if !bytes.Equal(s.lastEncodedIDR, idrNALU) {
		t.Fatalf("lastEncodedIDR should persist across subsequent P-frames, got %x", s.lastEncodedIDR)
	}
}

func TestClearCachedEncodedFrame_ClearsBothSlots(t *testing.T) {
	s := &Session{}
	s.cacheEncodedFrame(idrNALU)
	s.clearCachedEncodedFrame()

	s.lastEncodedMu.RLock()
	defer s.lastEncodedMu.RUnlock()
	if len(s.lastEncodedFrame) != 0 || len(s.lastEncodedIDR) != 0 {
		t.Fatalf("clearCachedEncodedFrame must reset both lastEncodedFrame and lastEncodedIDR")
	}
}
