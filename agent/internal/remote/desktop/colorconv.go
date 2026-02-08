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
	if nv12Pool.w == w && nv12Pool.h == h {
		nv12Pool.mu.Unlock()
		if v := nv12Pool.pool.Get(); v != nil {
			return v.([]byte)
		}
		return make([]byte, size)
	}
	nv12Pool.w = w
	nv12Pool.h = h
	nv12Pool.pool = sync.Pool{}
	nv12Pool.mu.Unlock()
	return make([]byte, size)
}

func putNV12Buffer(buf []byte) {
	nv12Pool.pool.Put(buf)
}

// bgraToNV12 converts BGRA pixel data to NV12 format for MFT H264 encoding.
// NV12 layout: [Y plane: w*h bytes] [UV interleaved plane: w*h/2 bytes]
// Uses BT.601 coefficients with fixed-point integer arithmetic.
func bgraToNV12(bgra []byte, width, height, stride int) []byte {
	nv12 := getNV12Buffer(width, height)
	yPlane := nv12[:width*height]
	uvPlane := nv12[width*height:]

	for y := 0; y < height; y++ {
		rowOff := y * stride
		yOff := y * width

		for x := 0; x < width; x++ {
			pi := rowOff + x*4
			b := int(bgra[pi+0])
			g := int(bgra[pi+1])
			r := int(bgra[pi+2])

			// Y = (66*R + 129*G + 25*B + 128) >> 8 + 16
			yVal := (66*r + 129*g + 25*b + 128) >> 8
			yVal += 16
			if yVal > 235 {
				yVal = 235
			}
			if yVal < 16 {
				yVal = 16
			}
			yPlane[yOff+x] = byte(yVal)

			// Subsample UV: one UV pair per 2x2 block
			if y%2 == 0 && x%2 == 0 {
				// Average the 2x2 block for better chroma quality
				// For simplicity and speed, use top-left pixel only
				uVal := (-38*r - 74*g + 112*b + 128) >> 8
				uVal += 128
				if uVal > 240 {
					uVal = 240
				}
				if uVal < 16 {
					uVal = 16
				}

				vVal := (112*r - 94*g - 18*b + 128) >> 8
				vVal += 128
				if vVal > 240 {
					vVal = 240
				}
				if vVal < 16 {
					vVal = 16
				}

				uvIdx := (y/2)*width + (x/2)*2
				uvPlane[uvIdx+0] = byte(uVal)
				uvPlane[uvIdx+1] = byte(vVal)
			}
		}
	}
	return nv12
}
