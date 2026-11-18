//go:build darwin && cgo

package desktop

import (
	"testing"
	"time"
)

// The C bridge returns NSEvent.doubleClickInterval in seconds and the Go
// wrapper converts it to a Duration. A value outside a plausible 100 ms to 5 s
// band means the unit conversion is wrong, not that the user chose it.
func TestSystemDoubleClickIntervalIsInSeconds(t *testing.T) {
	d := systemDoubleClickInterval()
	if d < 100*time.Millisecond || d > maxDoubleClickInterval {
		t.Fatalf("systemDoubleClickInterval() = %v, want between 100ms and %v", d, maxDoubleClickInterval)
	}
}
