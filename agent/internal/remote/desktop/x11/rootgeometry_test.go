package x11

import (
	"testing"
	"time"
)

// #11754: the X11 capturer re-reads the root window size at most once per
// interval on the capture path, and immediately when a capture failed (a
// shrunk root makes GetImage at the old size fail with BadMatch).
func TestRootGeometryPollDue(t *testing.T) {
	t0 := time.Unix(1000, 0)
	var p rootGeometryPoll
	if !p.due(t0, false) {
		t.Fatalf("the first check must run")
	}
	if p.due(t0.Add(rootGeometryCheckEvery/2), false) {
		t.Fatalf("a check inside the interval must not run")
	}
	if !p.due(t0.Add(rootGeometryCheckEvery/2), true) {
		t.Fatalf("a forced check (after a failed capture) must run inside the interval")
	}
	last := t0.Add(rootGeometryCheckEvery / 2)
	if p.due(last.Add(rootGeometryCheckEvery-time.Millisecond), false) {
		t.Fatalf("the forced check must restart the interval")
	}
	if !p.due(last.Add(rootGeometryCheckEvery), false) {
		t.Fatalf("a check after the interval must run")
	}
}

func TestRootSizeChanged(t *testing.T) {
	cases := []struct {
		curW, curH, newW, newH int
		want                   bool
	}{
		{1920, 1080, 1920, 1080, false},
		{1920, 1080, 2560, 1440, true},
		{1920, 1080, 1280, 720, true},
		{1920, 1080, 1920, 1200, true},
		{1920, 1080, 0, 0, false}, // a bogus reply is not a change
		{1920, 1080, 0, 1080, false},
	}
	for _, c := range cases {
		if got := rootSizeChanged(c.curW, c.curH, c.newW, c.newH); got != c.want {
			t.Errorf("rootSizeChanged(%dx%d -> %dx%d) = %v, want %v", c.curW, c.curH, c.newW, c.newH, got, c.want)
		}
	}
}
