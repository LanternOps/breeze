package desktop

import (
	"testing"
	"time"
)

// clickClock is a hand-advanced clock for the click counter.
type clickClock struct{ t time.Time }

func (c *clickClock) now() time.Time          { return c.t }
func (c *clickClock) advance(d time.Duration) { c.t = c.t.Add(d) }

const testInterval = 500 * time.Millisecond

func newTestCounter(clk *clickClock) *clickCounter {
	return newClickCounter(func() time.Duration { return testInterval }, clk.now)
}

// click presses and releases button at (x, y) and returns the click state
// the down and the up were given.
func click(c *clickCounter, button, x, y int) (down, up int) {
	down = c.down(button, x, y)
	up = c.up(button)
	return down, up
}

func TestClickCounter_SingleClickIsOne(t *testing.T) {
	c := newTestCounter(&clickClock{t: time.Unix(1000, 0)})
	if d, u := click(c, 0, 100, 100); d != 1 || u != 1 {
		t.Fatalf("single click = (down %d, up %d), want (1, 1)", d, u)
	}
}

func TestClickCounter_DoubleClickWithinInterval(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	clk.advance(200 * time.Millisecond)
	if d, u := click(c, 0, 100, 100); d != 2 || u != 2 {
		t.Fatalf("second click = (down %d, up %d), want (2, 2)", d, u)
	}
}

func TestClickCounter_TripleAndQuadrupleClick(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	for want := 1; want <= 4; want++ {
		if d, u := click(c, 0, 50, 60); d != want || u != want {
			t.Fatalf("click %d = (down %d, up %d), want (%d, %d)", want, d, u, want, want)
		}
		clk.advance(150 * time.Millisecond)
	}
}

// The interval runs from one press to the next, so a slow second click starts
// a new sequence: Finder's "click a selected item to rename" keeps working.
func TestClickCounter_SlowSecondClickResets(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	clk.advance(testInterval + time.Millisecond)
	if d, u := click(c, 0, 100, 100); d != 1 || u != 1 {
		t.Fatalf("slow second click = (down %d, up %d), want (1, 1)", d, u)
	}
}

func TestClickCounter_IntervalBoundaryIsInclusive(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	clk.advance(testInterval)
	if d := c.down(0, 100, 100); d != 2 {
		t.Fatalf("press exactly one interval later = %d, want 2", d)
	}
}

// In a longer sequence each press is timed from the press before it, not from
// the first: presses 400ms apart count 1, 2, 3 (the third is 800ms after the
// first), and a fourth press past the interval from the third starts over.
func TestClickCounter_ChainTimedFromPreviousPress(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	for want := 1; want <= 3; want++ {
		if want > 1 {
			clk.advance(400 * time.Millisecond)
		}
		if d, _ := click(c, 0, 100, 100); d != want {
			t.Fatalf("press %d = %d, want %d", want, d, want)
		}
	}
	clk.advance(testInterval + time.Millisecond)
	if d := c.down(0, 100, 100); d != 1 {
		t.Fatalf("press %v after the third = %d, want 1", testInterval+time.Millisecond, d)
	}
}

// A second release of the same button does not reuse the press's count.
func TestClickCounter_SecondUpIsOne(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	clk.advance(100 * time.Millisecond)
	click(c, 0, 100, 100)
	if u := c.up(0); u != 1 {
		t.Fatalf("release with no press after a double-click = %d, want 1", u)
	}
}

// A long press between two presses still times from press to press.
func TestClickCounter_IntervalMeasuredPressToPress(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	c.down(0, 100, 100)
	clk.advance(400 * time.Millisecond)
	c.up(0)
	clk.advance(200 * time.Millisecond)
	if d := c.down(0, 100, 100); d != 1 {
		t.Fatalf("press 600ms after the previous press = %d, want 1", d)
	}
}

func TestClickCounter_DistanceTolerance(t *testing.T) {
	cases := []struct {
		name   string
		dx, dy int
		want   int
	}{
		{"same point", 0, 0, 2},
		{"at tolerance on x", clickSlopPoints, 0, 2},
		{"at tolerance on both axes", -clickSlopPoints, clickSlopPoints, 2},
		{"beyond tolerance on x", clickSlopPoints + 1, 0, 1},
		{"beyond tolerance on y", 0, -(clickSlopPoints + 1), 1},
		{"far away", 200, 200, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clk := &clickClock{t: time.Unix(1000, 0)}
			c := newTestCounter(clk)
			click(c, 0, 300, 300)
			clk.advance(100 * time.Millisecond)
			if d, u := click(c, 0, 300+tc.dx, 300+tc.dy); d != tc.want || u != tc.want {
				t.Fatalf("second click offset (%d,%d) = (down %d, up %d), want %d", tc.dx, tc.dy, d, u, tc.want)
			}
		})
	}
}

// Distance is measured from the first press of the sequence, so small drifts
// cannot walk a triple-click across the screen.
func TestClickCounter_DistanceMeasuredFromSequenceStart(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	clk.advance(100 * time.Millisecond)
	if d, _ := click(c, 0, 100+clickSlopPoints, 100); d != 2 {
		t.Fatalf("second click = %d, want 2", d)
	}
	clk.advance(100 * time.Millisecond)
	if d, _ := click(c, 0, 100+2*clickSlopPoints, 100); d != 1 {
		t.Fatalf("third click drifted 2x tolerance from the first = %d, want 1", d)
	}
}

func TestClickCounter_ButtonSwitchResets(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	clk.advance(100 * time.Millisecond)
	if d, u := click(c, 1, 100, 100); d != 1 || u != 1 {
		t.Fatalf("right click after left = (down %d, up %d), want (1, 1)", d, u)
	}
	clk.advance(100 * time.Millisecond)
	if d, u := click(c, 0, 100, 100); d != 1 || u != 1 {
		t.Fatalf("left click after right = (down %d, up %d), want (1, 1)", d, u)
	}
	clk.advance(100 * time.Millisecond)
	if d, u := click(c, 0, 100, 100); d != 2 || u != 2 {
		t.Fatalf("second left click = (down %d, up %d), want (2, 2)", d, u)
	}
}

func TestClickCounter_MoveBeyondToleranceResets(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	// The pointer leaves and comes back before the second press.
	c.move(100+clickSlopPoints+1, 100)
	c.move(100, 100)
	clk.advance(100 * time.Millisecond)
	if d := c.down(0, 100, 100); d != 1 {
		t.Fatalf("press after leaving the tolerance box = %d, want 1", d)
	}
}

func TestClickCounter_MoveWithinToleranceKeepsSequence(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	c.move(101, 99)
	c.move(100+clickSlopPoints, 100-clickSlopPoints)
	clk.advance(100 * time.Millisecond)
	if d := c.down(0, 100, 100); d != 2 {
		t.Fatalf("press after jitter inside tolerance = %d, want 2", d)
	}
}

// Double-click-and-drag selects by word: the release after the drag keeps the
// press's count even though the pointer moved, but the next press starts over.
func TestClickCounter_DragKeepsUpCountButEndsSequence(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	clk.advance(100 * time.Millisecond)
	if d := c.down(0, 100, 100); d != 2 {
		t.Fatalf("second press = %d, want 2", d)
	}
	c.move(300, 100) // drag
	if u := c.up(0); u != 2 {
		t.Fatalf("release after double-click drag = %d, want 2", u)
	}
	clk.advance(100 * time.Millisecond)
	if d := c.down(0, 300, 100); d != 1 {
		t.Fatalf("press after drag = %d, want 1", d)
	}
}

func TestClickCounter_UpWithoutDownIsOne(t *testing.T) {
	c := newTestCounter(&clickClock{t: time.Unix(1000, 0)})
	if u := c.up(2); u != 1 {
		t.Fatalf("release with no press = %d, want 1", u)
	}
}

// A release reports the count of that button's own press, not of whichever
// button was pressed last.
func TestClickCounter_UpReportsOwnButtonsCount(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	c := newTestCounter(clk)
	click(c, 0, 100, 100)
	clk.advance(100 * time.Millisecond)
	c.down(0, 100, 100) // left double-click press, held
	c.down(1, 100, 100) // right press while left is held
	if u := c.up(1); u != 1 {
		t.Fatalf("right release = %d, want 1", u)
	}
	if u := c.up(0); u != 2 {
		t.Fatalf("left release = %d, want 2", u)
	}
}

// The interval is read on every press, so a change to the system setting
// applies without restarting the session.
func TestClickCounter_ReadsIntervalOnEachPress(t *testing.T) {
	clk := &clickClock{t: time.Unix(1000, 0)}
	interval := 500 * time.Millisecond
	c := newClickCounter(func() time.Duration { return interval }, clk.now)
	click(c, 0, 100, 100)
	interval = 1500 * time.Millisecond
	clk.advance(time.Second)
	if d := c.down(0, 100, 100); d != 2 {
		t.Fatalf("press 1s later with a 1.5s interval = %d, want 2", d)
	}
}

func TestClickCounter_UnusableIntervalFallsBackToDefault(t *testing.T) {
	for _, bad := range []time.Duration{0, -time.Second, time.Minute} {
		clk := &clickClock{t: time.Unix(1000, 0)}
		c := newClickCounter(func() time.Duration { return bad }, clk.now)
		click(c, 0, 100, 100)
		clk.advance(defaultDoubleClickInterval)
		if d, _ := click(c, 0, 100, 100); d != 2 {
			t.Fatalf("interval %v: press one default interval later = %d, want 2", bad, d)
		}
		clk.advance(defaultDoubleClickInterval + time.Millisecond)
		if d, _ := click(c, 0, 100, 100); d != 1 {
			t.Fatalf("interval %v: press past the default interval = %d, want 1", bad, d)
		}
	}
}

func TestClickCounter_NilFuncsUseDefaults(t *testing.T) {
	c := newClickCounter(nil, nil)
	if d, u := click(c, 0, 1, 1); d != 1 || u != 1 {
		t.Fatalf("first click = (down %d, up %d), want (1, 1)", d, u)
	}
	// Back to back on the real clock: well inside the default interval.
	if d := c.down(0, 1, 1); d != 2 {
		t.Fatalf("immediate second press = %d, want 2", d)
	}
}
