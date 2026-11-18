package wayland

import (
	"bufio"
	"bytes"
	"image"
	"image/jpeg"
	"io"
	"strings"
	"testing"
)

func TestStreamReaderSkipsPreamble(t *testing.T) {
	payload := []byte{0xFF, 0xD8, 0x00, 0x11, 0xFF, 0xD9}
	var full bytes.Buffer
	full.WriteString("Running as unit: run-example.service\n")
	bw := bufio.NewWriter(&full)
	if err := writeMsg(bw, msgFrame, payload); err != nil {
		t.Fatal(err)
	}
	if err := writeMsg(bw, msgError, []byte("user cancelled")); err != nil {
		t.Fatal(err)
	}

	r := newStreamReader(bytes.NewReader(full.Bytes()))
	kind, got, err := r.Next()
	if err != nil {
		t.Fatal(err)
	}
	if kind != msgFrame || !bytes.Equal(got, payload) {
		t.Fatalf("frame kind=%x payload=%x", kind, got)
	}
	kind, got, err = r.Next()
	if err != nil {
		t.Fatal(err)
	}
	if kind != msgError || string(got) != "user cancelled" {
		t.Fatalf("error kind=%x payload=%q", kind, got)
	}
	if _, _, err = r.Next(); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestTakeJPEG(t *testing.T) {
	a := []byte{0xFF, 0xD8, 0x01, 0xFF, 0x00, 0xFF, 0xD9}
	b := []byte{0xFF, 0xD8, 0x02, 0xFF, 0xD9}
	buf := append(append([]byte("junk"), a...), b...)
	frame, rest, ok := takeJPEG(buf)
	if !ok || !bytes.Equal(frame, a) {
		t.Fatalf("frame=%x ok=%v", frame, ok)
	}
	frame, rest, ok = takeJPEG(rest)
	if !ok || !bytes.Equal(frame, b) || len(rest) != 0 {
		t.Fatalf("frame=%x rest=%x ok=%v", frame, rest, ok)
	}
}

func TestFrameCapCovers8K(t *testing.T) {
	const w, h = 7680, 4320
	if int64(w)*int64(h) > maxFramePixels {
		t.Fatalf("8K %dx%d exceeds cap %d", w, h, maxFramePixels)
	}
	if maxFramePixels > 40_000_000 {
		t.Fatalf("cap %d is above 40 MP", maxFramePixels)
	}
}

func TestDecodeFrameBoundsPixels(t *testing.T) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2)), &jpeg.Options{Quality: 50}); err != nil {
		t.Fatal(err)
	}
	img, err := decodeFrame(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 2 || img.Bounds().Dy() != 2 {
		t.Fatalf("bounds %v", img.Bounds())
	}

	// A SOF header is enough for image/jpeg to allocate. Reject it before Decode.
	hostile := sofJPEG(65535, 65535)
	_, err = decodeFrame(hostile)
	if err == nil || !strings.Contains(err.Error(), "65535") {
		t.Fatalf("hostile frame: %v", err)
	}
}

// sofJPEG is a header image/jpeg will accept in DecodeConfig. DecodeConfig
// returns the SOF size when it reaches SOS, and only Decode allocates the
// pixel buffer, so this fixture must include a stub SOS.
func sofJPEG(width, height int) []byte {
	return []byte{
		0xFF, 0xD8,
		0xFF, 0xC0,
		0x00, 0x0B,
		0x08,
		byte(height >> 8), byte(height),
		byte(width >> 8), byte(width),
		0x01,
		0x01, 0x11, 0x00,
		0xFF, 0xDA,
		0x00, 0x02,
	}
}
