//go:build windows

package desktop

import (
	"testing"
)

func TestLinearToMulaw_Silence(t *testing.T) {
	// Silence (0) should encode to μ-law 0xFF
	got := linearToMulaw(0)
	if got != 0xFF {
		t.Fatalf("linearToMulaw(0) = 0x%02X, want 0xFF", got)
	}
}

func TestLinearToMulaw_Symmetry(t *testing.T) {
	// Positive and negative samples of same magnitude should differ only by sign bit (0x80)
	pos := linearToMulaw(1000)
	neg := linearToMulaw(-1000)
	if pos^neg != 0x80 {
		t.Fatalf("linearToMulaw(1000)=0x%02X, linearToMulaw(-1000)=0x%02X, XOR=0x%02X (want 0x80)",
			pos, neg, pos^neg)
	}
}

func TestLinearToMulaw_MaxClip(t *testing.T) {
	// Maximum positive value should not panic and should produce a valid byte
	got := linearToMulaw(32767)
	if got == 0xFF {
		t.Fatal("max positive should not encode as silence")
	}
}

func TestLinearToMulaw_MinClip(t *testing.T) {
	// Note: -32768 as int16 overflows when negated, but the function should handle it
	got := linearToMulaw(-32768)
	// Just verify it doesn't panic and produces a byte
	_ = got
}

func TestLinearToMulaw_MonotonicPositive(t *testing.T) {
	// μ-law is a companding function: larger magnitudes should produce
	// smaller encoded values (after bit inversion). We verify that the
	// decoded magnitude is monotonically non-decreasing for increasing input.
	prev := linearToMulaw(0)
	for i := int16(100); i < 32000; i += 100 {
		cur := linearToMulaw(i)
		// In μ-law encoding, larger input magnitudes produce smaller byte values
		// (due to the final bit inversion). So cur <= prev for increasing input.
		if cur > prev {
			t.Fatalf("non-monotonic at %d: prev=0x%02X, cur=0x%02X", i, prev, cur)
		}
		prev = cur
	}
}

func TestLinearToMulaw_KnownValues(t *testing.T) {
	// Test against known μ-law encoded values (ITU-T G.711)
	tests := []struct {
		input int16
		want  byte
	}{
		{0, 0xFF},  // silence
		{4, 0xFB},  // very small positive
		{-4, 0x7B}, // very small negative (sign bit flipped)
	}
	for _, tt := range tests {
		got := linearToMulaw(tt.input)
		if got != tt.want {
			t.Errorf("linearToMulaw(%d) = 0x%02X, want 0x%02X", tt.input, got, tt.want)
		}
	}
}

func BenchmarkLinearToMulaw(b *testing.B) {
	for i := 0; i < b.N; i++ {
		linearToMulaw(int16(i % 65536))
	}
}
