package desktop

import "testing"

func TestExpectedRGBAFrameSize(t *testing.T) {
	size, err := expectedRGBAFrameSize(1920, 1080)
	if err != nil {
		t.Fatalf("expected valid frame size, got error: %v", err)
	}
	if size != 1920*1080*4 {
		t.Fatalf("unexpected frame size: got %d", size)
	}
}

func TestExpectedRGBAFrameSizeRejectsInvalidDimensions(t *testing.T) {
	if _, err := expectedRGBAFrameSize(0, 1080); err == nil {
		t.Fatal("expected zero width to be rejected")
	}
	if _, err := expectedRGBAFrameSize(-1, 1080); err == nil {
		t.Fatal("expected negative width to be rejected")
	}
}

func TestExpectedRGBAFrameSizeRejectsOverflow(t *testing.T) {
	if _, err := expectedRGBAFrameSize(1<<40, 1<<30); err == nil {
		t.Fatal("expected oversized dimensions to be rejected")
	}
}
