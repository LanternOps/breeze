package websocket

import (
	"math/rand/v2"
	"time"
)

// clock is the time seam for the reconnect loop's waits (W09, #8148). The
// connection itself (read/write deadlines, ping ticker, handshake timeout)
// stays on real time; only the waits between connections and the
// "how long did that socket live" measurement go through it, so timing tests
// can drive the loop on a fake clock instead of sleeping.
type clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// wsClock and wsRand are package-level seams, swapped only by tests
// (installFakeWSClock, installWSRand). The reconnect loop reads wsRand once
// when it starts and wsClock on every wait.
var (
	wsClock clock = realClock{}
	wsRand        = rand.Float64
)
