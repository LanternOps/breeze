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

// EncodePNG encodes an image as PNG (lossless)
func EncodePNG(img *image.RGBA) ([]byte, error) {
	buf := new(bytes.Buffer)
	err := png.Encode(buf, img)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ScaleImage scales an image by the given factor (0.0-1.0)
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

	// Simple nearest-neighbor scaling
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
