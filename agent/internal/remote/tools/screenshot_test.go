package tools

import (
	"image"
	"image/color"
	"strings"
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

// nilFrameCapture is a fake capturer that reports no frame and no error —
// what the Windows GDI path did at the sign-in screen (#10304).
func nilFrameCapture(int) (*image.RGBA, int, int, error) { return nil, 1920, 1080, nil }

// A nil frame with no error must yield a prompt failed result, not a
// nil-pointer panic that leaves the IPC caller waiting out its 65 s budget.
func TestTakeScreenshotWithCaptureNilFrameNoError(t *testing.T) {
	result := TakeScreenshotWithCapture(map[string]any{}, nilFrameCapture)

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "no frame") {
		t.Fatalf("error = %q, want it to mention the missing frame", result.Error)
	}
}

func TestCaptureScreenshotWithFnNilFrameNoError(t *testing.T) {
	resp, err := captureScreenshotWithFn(0, nilFrameCapture)

	if err == nil {
		t.Fatalf("expected an error for a nil frame, got response %+v", resp)
	}
	if !strings.Contains(err.Error(), "no frame") {
		t.Fatalf("error = %q, want it to mention the missing frame", err)
	}
}

func TestEncodeScreenshotResponseNilImage(t *testing.T) {
	_, err := encodeScreenshotResponse(nil, 1920, 1080, 0)
	if err == nil || !strings.Contains(err.Error(), "no frame") {
		t.Fatalf("err = %v, want a no-frame error", err)
	}
}
