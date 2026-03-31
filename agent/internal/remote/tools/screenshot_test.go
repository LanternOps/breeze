package tools

import (
	"image"
	"image/color"
	"testing"
)

func TestEncodeScreenshotResponseRejectsOversizedPayload(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2200, 2200))
	for y := 0; y < 2200; y++ {
		for x := 0; x < 2200; x++ {
			v := uint8((x*31 + y*17) % 256)
			img.SetRGBA(x, y, color.RGBA{
				R: v,
				G: uint8((x * 13) % 256),
				B: uint8((y * 7) % 256),
				A: 255,
			})
		}
	}

	resp, err := encodeScreenshotResponse(img, 2200, 2200, 0)
	if err == nil && len(resp.ImageBase64) > maxScreenshotBase64Bytes {
		t.Fatalf("expected encoded screenshot to stay within limit, got %d bytes", len(resp.ImageBase64))
	}
}
