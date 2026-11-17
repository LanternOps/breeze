package desktop

import (
	"sync"
	"time"
)

// Click-count tracking for synthesized mouse events (issue #11549), untagged so
// it is unit-tested on every OS. Only the macOS handler uses it today.
//
// CGEventCreateMouseEvent leaves the event's kCGMouseEventClickState field at 1,
// and macOS does not appear to work out the click count of a posted event: in
// #11549 every remote double-click arrived as two single clicks (AppKit's
// NSEvent.clickCount is read from that field), so Finder treated the second
// one as a click on an already-selected item and started a rename.
//
// The rules are modelled on what the HID system does for a real mouse: a press of the
// same button, within the system double-click interval of the previous press
// and within a few points of where the sequence started, continues the
// sequence (2, 3, 4, ...); anything else starts a new one at 1. A release
// carries the count of that button's press. Moving the pointer out of the
// tolerance box between presses also ends the sequence.

const (
	// clickSlopPoints is how far, in macOS points on each axis, a press may land
	// from the first press of the sequence and still continue it. Coordinates
	// arrive already scaled from video pixels to points.
	clickSlopPoints = 4

	// defaultDoubleClickInterval is the macOS default double-click interval,
	// used when the system value cannot be read or is out of range.
	defaultDoubleClickInterval = 500 * time.Millisecond

	// maxDoubleClickInterval is a sanity cap on the value read from the
	// system. The System Settings slider goes up to about 5 s; a larger value
	// (a bad read, or one set by hand) falls back to the default.
	maxDoubleClickInterval = 5 * time.Second
)

// clickCounter assigns a click state to each synthesized press and release.
// It is safe for concurrent use.
type clickCounter struct {
	interval func() time.Duration
	now      func() time.Time

	mu sync.Mutex
	// The current sequence: the button, where its first press landed, when
	// the latest press happened and its count. inSeq is false when there is
	// no sequence to continue.
	inSeq     bool
	seqButton int
	seqX      int
	seqY      int
	lastPress time.Time
	count     int
	// pressCount is the count given to each button's most recent press, which
	// its release repeats.
	pressCount map[int]int
}

// newClickCounter returns a counter that reads the double-click interval from
// interval on every press (so a changed system setting applies at once) and
// the time from now. A nil interval uses the default; a nil now uses
// time.Now.
func newClickCounter(interval func() time.Duration, now func() time.Time) *clickCounter {
	if now == nil {
		now = time.Now
	}
	return &clickCounter{interval: interval, now: now, pressCount: make(map[int]int)}
}

func (c *clickCounter) currentInterval() time.Duration {
	if c.interval == nil {
		return defaultDoubleClickInterval
	}
	d := c.interval()
	if d <= 0 || d > maxDoubleClickInterval {
		return defaultDoubleClickInterval
	}
	return d
}

func withinSlop(x0, y0, x1, y1 int) bool {
	dx, dy := x1-x0, y1-y0
	return dx >= -clickSlopPoints && dx <= clickSlopPoints &&
		dy >= -clickSlopPoints && dy <= clickSlopPoints
}

// down records a press of button at (x, y) and returns its click state.
func (c *clickCounter) down(button, x, y int) int {
	interval := c.currentInterval()
	now := c.now()

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.inSeq && button == c.seqButton &&
		now.Sub(c.lastPress) <= interval &&
		withinSlop(c.seqX, c.seqY, x, y) {
		c.count++
	} else {
		c.inSeq = true
		c.seqButton = button
		c.seqX, c.seqY = x, y
		c.count = 1
	}
	c.lastPress = now
	c.pressCount[button] = c.count
	return c.count
}

// up returns the click state for a release of button: the count its press was
// given, or 1 for a release with no recorded press.
func (c *clickCounter) up(button int) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n, ok := c.pressCount[button]
	if !ok {
		return 1
	}
	delete(c.pressCount, button)
	return n
}

// move records the pointer moving to (x, y). Leaving the tolerance box around
// the sequence's first press ends the sequence; a release still carries its
// press's count, so a double-click-and-drag selects by word.
func (c *clickCounter) move(x, y int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.inSeq && !withinSlop(c.seqX, c.seqY, x, y) {
		c.inSeq = false
	}
}
