package desktop

import "fmt"

// AlignEven rounds width and height down to the nearest even non-negative
// integer. H264 (and VP9, AV1, and most other modern video codecs) require
// even dimensions because 4:2:0 chroma subsampling operates on 2x2 pixel
// blocks. Capturers running on displays with odd-pixel dimensions — common
// at fractional DPI scaling, e.g. 1920x1200 at 125% = 1512x949 — MUST round
// down at allocation time so the capture buffer is consistent with the
// encoder's configured size.
//
// Negative inputs are clamped to zero rather than wrapping, so a misconfigured
// caller can't produce a buffer with a negative length.
func AlignEven(w, h int) (int, int) {
	if w < 0 {
		w = 0
	}
	if h < 0 {
		h = 0
	}
	return w &^ 1, h &^ 1
}

// FitRGBAFrame returns input sliced to exactly w*h*4 bytes (one RGBA-or-BGRA
// frame at the given dimensions). If input is already the right length, it is
// returned unchanged — the hot path does not allocate or copy. If input is
// exactly one row of pixels longer than expected, it is silently truncated to
// w*h*4; this defense-in-depth accommodates a capturer that has not yet been
// updated to [AlignEven] its output, so we never regress to the hard-error
// behavior that produced the Kit "frame size 1434888 doesn't match 1512x948"
// failure loop. Any other length mismatch is a real bug and returns an error.
func FitRGBAFrame(input []byte, w, h int) ([]byte, error) {
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("FitRGBAFrame: invalid dimensions %dx%d", w, h)
	}
	expected := w * h * 4
	switch len(input) {
	case expected:
		return input, nil
	case w * (h + 1) * 4:
		// Exactly one extra row — silently crop. Keeps the top h rows;
		// the bottom row is the unsafe one on odd-height displays
		// (the scan-line below the taskbar on fractional-DPI panels).
		return input[:expected], nil
	default:
		return nil, fmt.Errorf("FitRGBAFrame: frame size %d doesn't match %dx%d (expected %d bytes)",
			len(input), w, h, expected)
	}
}
