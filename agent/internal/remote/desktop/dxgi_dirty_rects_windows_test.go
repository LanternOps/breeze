//go:build windows

package desktop

import (
	"image"
	"testing"
)

func TestMergeDirtyRects_Empty(t *testing.T) {
	result := mergeDirtyRects(nil)
	if !result.Empty() {
		t.Errorf("expected empty rect, got %v", result)
	}
}

func TestMergeDirtyRects_Single(t *testing.T) {
	rects := []image.Rectangle{image.Rect(10, 20, 100, 200)}
	result := mergeDirtyRects(rects)
	expected := image.Rect(10, 20, 100, 200)
	if result != expected {
		t.Errorf("expected %v, got %v", expected, result)
	}
}

func TestMergeDirtyRects_Multiple(t *testing.T) {
	rects := []image.Rectangle{
		image.Rect(10, 20, 100, 200),
		image.Rect(500, 300, 600, 400),
	}
	result := mergeDirtyRects(rects)
	expected := image.Rect(10, 20, 600, 400)
	if result != expected {
		t.Errorf("expected %v, got %v", expected, result)
	}
}

func TestDirtyRectCoversFraction(t *testing.T) {
	tests := []struct {
		name     string
		dirty    image.Rectangle
		w, h     int
		expected float64
	}{
		{"full screen", image.Rect(0, 0, 1920, 1080), 1920, 1080, 1.0},
		{"quarter", image.Rect(0, 0, 960, 540), 1920, 1080, 0.25},
		{"small region", image.Rect(100, 100, 132, 132), 1920, 1080, 0.000494},
		{"zero screen", image.Rect(0, 0, 100, 100), 0, 0, 1.0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := dirtyRectCoversFraction(tt.dirty, tt.w, tt.h)
			if got < tt.expected-0.001 || got > tt.expected+0.001 {
				t.Errorf("expected ~%f, got %f", tt.expected, got)
			}
		})
	}
}
