package websocket

import (
	"testing"
	"time"
)

func TestFakeWSClockFiresOnlyOnAdvance(t *testing.T) {
	clk := installFakeWSClock(t)
	ch := wsClock.After(30 * time.Second)
	clk.WaitForWaiters(t, 1)
	clk.Advance(29 * time.Second)
	select {
	case <-ch:
		t.Fatal("fired before its deadline")
	default:
	}
	clk.Advance(time.Second)
	select {
	case <-ch:
	default:
		t.Fatal("did not fire at its deadline")
	}
}

func TestFakeWSClockNowAdvances(t *testing.T) {
	clk := installFakeWSClock(t)
	start := wsClock.Now()
	clk.Advance(31 * time.Second)
	if got := wsClock.Now().Sub(start); got != 31*time.Second {
		t.Fatalf("Now advanced %v, want 31s", got)
	}
}

func TestFakeWSClockZeroDurationFiresAtOnce(t *testing.T) {
	installFakeWSClock(t)
	select {
	case <-wsClock.After(0):
	default:
		t.Fatal("After(0) did not fire at once")
	}
}
