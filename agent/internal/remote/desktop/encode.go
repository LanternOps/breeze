package desktop

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
)

// EncodeJPEG encodes an image as JPEG with the specified quality (1-100)
func EncodeJPEG(img *image.RGBA, quality int) ([]byte, error) {
	if quality < 1 {
		quality = 1
	}
	if quality > 100 {
		quality = 100
	}

	buf := new(bytes.Buffer)
	err := jpeg.Encode(buf, img, &jpeg.Options{Quality: quality})
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// EncodeJPEGPooled encodes JPEG using a pooled buffer. The caller must call
// putBuffer(buf) after consuming buf.Bytes(). Returns the buffer so the
// caller can manage the pool lifecycle.
func EncodeJPEGPooled(img *image.RGBA, quality int) (*bytes.Buffer, error) {
	if quality < 1 {
		quality = 1
	}
	if quality > 100 {
		quality = 100
	}

	buf := getBuffer()
	err := jpeg.Encode(buf, img, &jpeg.Options{Quality: quality})
	if err != nil {
		putBuffer(buf)
		return nil, err
	}
	return buf, nil
}

// EncodePNG encodes an image as PNG (lossless)
func EncodePNG(img *image.RGBA) ([]byte, error) {
	buf := new(bytes.Buffer)
	err := png.Encode(buf, img)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ScaleImage scales an image by the given factor using Set()/At() (legacy).
func ScaleImage(img *image.RGBA, factor float64) *image.RGBA {
	if factor >= 1.0 {
		return img
	}
	if factor <= 0 {
		factor = 0.1
	}

	bounds := img.Bounds()
	newWidth := int(float64(bounds.Dx()) * factor)
	newHeight := int(float64(bounds.Dy()) * factor)

	if newWidth < 1 {
		newWidth = 1
	}
	if newHeight < 1 {
		newHeight = 1
	}

	scaled := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))

	xRatio := float64(bounds.Dx()) / float64(newWidth)
	yRatio := float64(bounds.Dy()) / float64(newHeight)

	for y := 0; y < newHeight; y++ {
		for x := 0; x < newWidth; x++ {
			srcX := int(float64(x) * xRatio)
			srcY := int(float64(y) * yRatio)
			scaled.Set(x, y, img.At(srcX, srcY))
		}
	}

	return scaled
}

// ScaleImageFast performs nearest-neighbor downscale using direct Pix slice
// manipulation. Approximately 10-20x faster than ScaleImage for typical resolutions.
func ScaleImageFast(img *image.RGBA, factor float64) *image.RGBA {
	if factor >= 1.0 {
		return img
	}
	if factor <= 0 {
		factor = 0.1
	}

	srcBounds := img.Bounds()
	srcW := srcBounds.Dx()
	srcH := srcBounds.Dy()
	dstW := int(float64(srcW) * factor)
	dstH := int(float64(srcH) * factor)
	if dstW < 1 {
		dstW = 1
	}
	if dstH < 1 {
		dstH = 1
	}

	scaled := scaledImagePool.Get(dstW, dstH)

	// Pre-compute source X byte offsets for each dst column
	srcXOffsets := make([]int, dstW)
	for x := 0; x < dstW; x++ {
		srcXOffsets[x] = (x * srcW / dstW) * 4
	}

	srcPix := img.Pix
	dstPix := scaled.Pix
	srcStride := img.Stride
	dstStride := scaled.Stride

	for y := 0; y < dstH; y++ {
		srcY := y * srcH / dstH
		srcRowBase := srcY * srcStride
		dstRowBase := y * dstStride

		for x := 0; x < dstW; x++ {
			si := srcRowBase + srcXOffsets[x]
			di := dstRowBase + x*4

			dstPix[di+0] = srcPix[si+0]
			dstPix[di+1] = srcPix[si+1]
			dstPix[di+2] = srcPix[si+2]
			dstPix[di+3] = srcPix[si+3]
		}
	}

	return scaled
}

// bgraToRGBA converts a BGRA pixel buffer to RGBA in-place or into a dest slice.
func bgraToRGBA(src, dst []byte, pixelCount int) {
	n := pixelCount * 4
	for i := 0; i < n; i += 4 {
		dst[i+0] = src[i+2] // R <- B
		dst[i+1] = src[i+1] // G
		dst[i+2] = src[i+0] // B <- R
		dst[i+3] = 255      // A
	}
}
