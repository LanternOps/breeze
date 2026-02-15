package desktop

import "sync"

// nv12Pool pools NV12 buffers for a fixed resolution.
var nv12Pool = struct {
	pool sync.Pool
	w, h int
	mu   sync.Mutex
}{}

func getNV12Buffer(w, h int) []byte {
	size := w*h + w*h/2 // Y + UV
	nv12Pool.mu.Lock()
	nv12Pool.w = w
	nv12Pool.h = h
	nv12Pool.mu.Unlock()

	for {
		v := nv12Pool.pool.Get()
		if v == nil {
			break
		}
		buf := v.([]byte)
		// Verify pooled buffer is correct size. The pool can be contaminated if
		// callers encode different resolutions concurrently.
		if len(buf) == size {
			return buf
		}
	}
	return make([]byte, size)
}

func putNV12Buffer(buf []byte) {
	// Best-effort: only pool buffers for the current resolution.
	nv12Pool.mu.Lock()
	w, h := nv12Pool.w, nv12Pool.h
	nv12Pool.mu.Unlock()
	if w > 0 && h > 0 {
		expected := w*h + w*h/2
		if len(buf) != expected {
			return
		}
	}
	nv12Pool.pool.Put(buf)
}

// bgraToNV12 converts BGRA pixel data to NV12 format for MFT H264 encoding.
// Identical to rgbaToNV12 but operates on BGRA channel order (B=pi+0, G=pi+1,
// R=pi+2, A=pi+3), eliminating the need for a BGRA→RGBA conversion pass.
func bgraToNV12(bgra []byte, width, height, stride int) []byte {
	expectedSize := height * stride
	if len(bgra) < expectedSize {
		nv12 := getNV12Buffer(width, height)
		clear(nv12)
		return nv12
	}

	nv12 := getNV12Buffer(width, height)
	yPlane := nv12[:width*height]
	uvPlane := nv12[width*height:]

	// Pass 1: Y plane — BGRA order: R=pi+2, G=pi+1, B=pi+0
	w4 := width &^ 3
	for y := 0; y < height; y++ {
		rowStart := y * stride
		row := bgra[rowStart : rowStart+width*4]
		yOff := y * width
		yRow := yPlane[yOff : yOff+width]

		x := 0
		for ; x < w4; x += 4 {
			pi := x * 4
			yRow[x] = byte((66*int(row[pi+2]) + 129*int(row[pi+1]) + 25*int(row[pi]) + 128) >> 8 + 16)
			yRow[x+1] = byte((66*int(row[pi+6]) + 129*int(row[pi+5]) + 25*int(row[pi+4]) + 128) >> 8 + 16)
			yRow[x+2] = byte((66*int(row[pi+10]) + 129*int(row[pi+9]) + 25*int(row[pi+8]) + 128) >> 8 + 16)
			yRow[x+3] = byte((66*int(row[pi+14]) + 129*int(row[pi+13]) + 25*int(row[pi+12]) + 128) >> 8 + 16)
		}
		for ; x < width; x++ {
			pi := x * 4
			yRow[x] = byte((66*int(row[pi+2]) + 129*int(row[pi+1]) + 25*int(row[pi]) + 128) >> 8 + 16)
		}
	}

	// Pass 2: UV plane — BGRA order: R=pi+2, G=pi+1, B=pi+0
	for y := 0; y < height; y += 2 {
		rowStart := y * stride
		row := bgra[rowStart : rowStart+width*4]
		uvOff := (y / 2) * width
		uvRow := uvPlane[uvOff : uvOff+width]

		for x := 0; x < width; x += 2 {
			pi := x * 4
			r := int(row[pi+2])
			g := int(row[pi+1])
			b := int(row[pi])

			uvRow[x] = byte((-38*r - 74*g + 112*b + 128) >> 8 + 128)
			uvRow[x+1] = byte((112*r - 94*g - 18*b + 128) >> 8 + 128)
		}
	}
	return nv12
}

// rgbaToNV12 converts RGBA pixel data to NV12 format for MFT H264 encoding.
// NV12 layout: [Y plane: w*h bytes] [UV interleaved plane: w*h/2 bytes]
//
// Uses BT.601 coefficients with fixed-point integer arithmetic.
// For 0-255 RGB input, Y is provably in [16,235] and UV in [16,240],
// so no clamping is needed.
//
// Split into two passes (Y-only, then UV-only) for better cache locality
// and to eliminate the per-pixel UV branch from the hot Y loop.
func rgbaToNV12(rgba []byte, width, height, stride int) []byte {
	expectedSize := height * stride
	if len(rgba) < expectedSize {
		nv12 := getNV12Buffer(width, height)
		clear(nv12) // return zeroed buffer on short input
		return nv12
	}

	nv12 := getNV12Buffer(width, height)
	yPlane := nv12[:width*height]
	uvPlane := nv12[width*height:]

	// Pass 1: Y plane — tight loop, no UV branch, no clamping needed.
	// Process 4 pixels per iteration to reduce loop overhead.
	w4 := width &^ 3 // round down to multiple of 4
	for y := 0; y < height; y++ {
		rowStart := y * stride
		row := rgba[rowStart : rowStart+width*4]
		yOff := y * width
		yRow := yPlane[yOff : yOff+width]

		x := 0
		for ; x < w4; x += 4 {
			pi := x * 4
			yRow[x] = byte((66*int(row[pi]) + 129*int(row[pi+1]) + 25*int(row[pi+2]) + 128) >> 8 + 16)
			yRow[x+1] = byte((66*int(row[pi+4]) + 129*int(row[pi+5]) + 25*int(row[pi+6]) + 128) >> 8 + 16)
			yRow[x+2] = byte((66*int(row[pi+8]) + 129*int(row[pi+9]) + 25*int(row[pi+10]) + 128) >> 8 + 16)
			yRow[x+3] = byte((66*int(row[pi+12]) + 129*int(row[pi+13]) + 25*int(row[pi+14]) + 128) >> 8 + 16)
		}
		for ; x < width; x++ {
			pi := x * 4
			yRow[x] = byte((66*int(row[pi]) + 129*int(row[pi+1]) + 25*int(row[pi+2]) + 128) >> 8 + 16)
		}
	}

	// Pass 2: UV plane — process even rows only, subsample 2x2 blocks.
	for y := 0; y < height; y += 2 {
		rowStart := y * stride
		row := rgba[rowStart : rowStart+width*4]
		uvOff := (y / 2) * width
		uvRow := uvPlane[uvOff : uvOff+width]

		for x := 0; x < width; x += 2 {
			pi := x * 4
			r := int(row[pi])
			g := int(row[pi+1])
			b := int(row[pi+2])

			uvRow[x] = byte((-38*r - 74*g + 112*b + 128) >> 8 + 128)
			uvRow[x+1] = byte((112*r - 94*g - 18*b + 128) >> 8 + 128)
		}
	}
	return nv12
}
