package desktop

import (
	"errors"
	"image"
	"testing"
	"time"
)

func TestProbeCaptureFirstFrame(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	got, err := probeCapture(func() (*image.RGBA, error) { return img, nil }, 3, time.Millisecond)
	if err != nil || got != img {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestProbeCaptureRetriesNilFrame(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	calls := 0
	got, err := probeCapture(func() (*image.RGBA, error) {
		calls++
		if calls < 3 {
			return nil, nil // GDI transient: no frame, no error
		}
		return img, nil
	}, 5, time.Millisecond)
	if err != nil || got != img || calls != 3 {
		t.Fatalf("got %v err %v calls %d", got, err, calls)
	}
}

func TestProbeCaptureNilFrameExhausted(t *testing.T) {
	got, err := probeCapture(func() (*image.RGBA, error) { return nil, nil }, 4, time.Millisecond)
	if got != nil || err == nil {
		t.Fatalf("exhausted nil-frame probe must error, got %v err %v", got, err)
	}
}

func TestProbeCaptureHardErrorImmediate(t *testing.T) {
	sentinel := errors.New("boom")
	calls := 0
	_, err := probeCapture(func() (*image.RGBA, error) { calls++; return nil, sentinel }, 5, time.Millisecond)
	if !errors.Is(err, sentinel) || calls != 1 {
		t.Fatalf("hard error must propagate on first call, err %v calls %d", err, calls)
	}
}
