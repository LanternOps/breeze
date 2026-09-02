package desktop

import (
	"errors"
	"image"
	"slices"
	"testing"
	"time"
)

func TestProbeCaptureFirstFrame(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	got, err := probeCapture(func() (*image.RGBA, error) { return img, nil }, 3, time.Millisecond, nil)
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
	}, 5, time.Millisecond, nil)
	if err != nil || got != img || calls != 3 {
		t.Fatalf("got %v err %v calls %d", got, err, calls)
	}
}

func TestProbeCaptureNilFrameExhausted(t *testing.T) {
	got, err := probeCapture(func() (*image.RGBA, error) { return nil, nil }, 4, time.Millisecond, nil)
	if got != nil || err == nil {
		t.Fatalf("exhausted nil-frame probe must error, got %v err %v", got, err)
	}
}

func TestProbeCaptureHardErrorImmediate(t *testing.T) {
	sentinel := errors.New("boom")
	calls := 0
	_, err := probeCapture(func() (*image.RGBA, error) { calls++; return nil, sentinel }, 5, time.Millisecond, nil)
	if !errors.Is(err, sentinel) || calls != 1 {
		t.Fatalf("hard error must propagate on first call, err %v calls %d", err, calls)
	}
}

// TestProbeCaptureNilRepaintIsSafe guards the non-Windows caller shape, where
// newProbeRepainter returns a no-op, and any caller that passes nil outright.
func TestProbeCaptureNilRepaintIsSafe(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	got, err := probeCapture(func() (*image.RGBA, error) { return img, nil }, 3, time.Millisecond, nil)
	if err != nil || got != img {
		t.Fatalf("nil repaint must not panic; got %v err %v", got, err)
	}
}

// captureResult is one scripted (img, err) answer from the fake capturer.
type captureResult struct {
	img *image.RGBA
	err error
}

// errExhaustedMarker stands in for "probeCapture should return its own
// out-of-attempts error". That error is built with fmt.Errorf and wraps
// nothing, so it can't be matched with errors.Is — the marker keeps the table
// declarative.
var errExhaustedMarker = errors.New("test marker: attempts exhausted")

// TestProbeCaptureRepaintSequence pins the #3951 contract: the probe must force
// a desktop repaint before *every* capture attempt, including the first,
// because DXGI Desktop Duplication only yields a frame when desktop content
// changes. The recorded event sequence is the assertion — a "capture" not
// immediately preceded by a "repaint" is the bug this fixes. It also pins the
// two behaviours the fix must NOT change: the retry ceiling, and a hard
// capture error aborting immediately.
func TestProbeCaptureRepaintSequence(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	deviceLost := errors.New("AcquireNextFrame: 0x887A0026")

	tests := []struct {
		name     string
		attempts int
		// results is consumed one per attempt; the last entry repeats.
		results []captureResult
		wantSeq []string
		wantImg *image.RGBA
		wantErr error
	}{
		{
			name:     "frame on first attempt is still preceded by a repaint",
			attempts: 5,
			results:  []captureResult{{img, nil}},
			wantSeq:  []string{"repaint", "capture"},
			wantImg:  img,
		},
		{
			name:     "idle desktop: a repaint precedes every retry until a frame lands",
			attempts: 5,
			results:  []captureResult{{nil, nil}, {nil, nil}, {img, nil}},
			wantSeq:  []string{"repaint", "capture", "repaint", "capture", "repaint", "capture"},
			wantImg:  img,
		},
		{
			name:     "genuinely dead desktop: one repaint per attempt, ceiling unchanged",
			attempts: 3,
			results:  []captureResult{{nil, nil}},
			wantSeq:  []string{"repaint", "capture", "repaint", "capture", "repaint", "capture"},
			wantErr:  errExhaustedMarker,
		},
		{
			name:     "hard capture error aborts after the first repaint+capture",
			attempts: 5,
			results:  []captureResult{{nil, deviceLost}},
			wantSeq:  []string{"repaint", "capture"},
			wantErr:  deviceLost,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var seq []string
			attempt := 0
			capture := func() (*image.RGBA, error) {
				seq = append(seq, "capture")
				r := tc.results[min(attempt, len(tc.results)-1)]
				attempt++
				return r.img, r.err
			}
			repaint := func() { seq = append(seq, "repaint") }

			got, err := probeCapture(capture, tc.attempts, time.Millisecond, repaint)

			if !slices.Equal(seq, tc.wantSeq) {
				t.Errorf("event sequence = %v, want %v", seq, tc.wantSeq)
			}
			if got != tc.wantImg {
				t.Errorf("img = %v, want %v", got, tc.wantImg)
			}
			switch {
			case tc.wantErr == errExhaustedMarker:
				if err == nil {
					t.Errorf("want out-of-attempts error, got nil")
				}
			case tc.wantErr != nil:
				if !errors.Is(err, tc.wantErr) {
					t.Errorf("err = %v, want %v", err, tc.wantErr)
				}
			default:
				if err != nil {
					t.Errorf("unexpected err %v", err)
				}
			}
		})
	}
}
