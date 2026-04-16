package desktop

import "testing"

func TestAlignEven(t *testing.T) {
	cases := []struct {
		name                     string
		inW, inH, wantW, wantH int
	}{
		{"both even passes through", 1920, 1080, 1920, 1080},
		{"Kit repro 1512x949 rounds height down", 1512, 949, 1512, 948},
		{"both odd rounds both down", 1511, 949, 1510, 948},
		{"odd width only", 1921, 1080, 1920, 1080},
		{"small odd pair", 3, 5, 2, 4},
		{"zero passes through", 0, 0, 0, 0},
		{"negative clamps to zero", -1, -3, 0, 0},
		{"mixed negative and even", -5, 1080, 0, 1080},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotW, gotH := AlignEven(tc.inW, tc.inH)
			if gotW != tc.wantW || gotH != tc.wantH {
				t.Errorf("AlignEven(%d, %d) = (%d, %d), want (%d, %d)",
					tc.inW, tc.inH, gotW, gotH, tc.wantW, tc.wantH)
			}
		})
	}
}

func TestFitRGBAFrame(t *testing.T) {
	const (
		w = 1512
		h = 948
	)
	exactLen := w * h * 4               // RGBA pixels at the rounded dimensions
	oneExtraRow := w * (h + 1) * 4       // what an un-rounded 1512x949 GDI capturer produces
	twoExtraRows := w * (h + 2) * 4
	tooSmall := w * (h - 1) * 4

	t.Run("exact match returns input unchanged", func(t *testing.T) {
		input := make([]byte, exactLen)
		for i := range input {
			input[i] = byte(i)
		}
		got, err := FitRGBAFrame(input, w, h)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != exactLen {
			t.Fatalf("len(got) = %d, want %d", len(got), exactLen)
		}
		// Must be the same backing bytes (no copy for the fast path).
		if &got[0] != &input[0] {
			t.Errorf("expected same backing slice for exact-match fast path")
		}
	})

	t.Run("Kit repro: one extra row silently cropped", func(t *testing.T) {
		input := make([]byte, oneExtraRow)
		// Mark the first exactLen bytes distinctly so we can assert the crop
		// keeps the TOP rows, not the bottom.
		for i := 0; i < exactLen; i++ {
			input[i] = 0xAA
		}
		for i := exactLen; i < oneExtraRow; i++ {
			input[i] = 0xBB
		}
		got, err := FitRGBAFrame(input, w, h)
		if err != nil {
			t.Fatalf("unexpected error for one-extra-row input: %v", err)
		}
		if len(got) != exactLen {
			t.Fatalf("len(got) = %d, want %d", len(got), exactLen)
		}
		// Every byte of the returned slice must be the "top rows" marker.
		for i, b := range got {
			if b != 0xAA {
				t.Fatalf("byte %d = %#x, want 0xAA (crop must keep top rows, not bottom)", i, b)
			}
		}
	})

	t.Run("two extra rows is still an error", func(t *testing.T) {
		input := make([]byte, twoExtraRows)
		if _, err := FitRGBAFrame(input, w, h); err == nil {
			t.Error("expected error for two-extra-rows input, got nil")
		}
	})

	t.Run("too small is an error", func(t *testing.T) {
		input := make([]byte, tooSmall)
		if _, err := FitRGBAFrame(input, w, h); err == nil {
			t.Error("expected error for too-small input, got nil")
		}
	})

	t.Run("zero dimensions errors instead of panicking", func(t *testing.T) {
		input := make([]byte, 16)
		if _, err := FitRGBAFrame(input, 0, 0); err == nil {
			t.Error("expected error for zero dimensions, got nil")
		}
	})
}
