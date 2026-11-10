//go:build darwin && cgo

package desktop

import (
	"testing"
	"time"
)

// The bridge returns NSEvent.doubleClickInterval converted from seconds. The
// System Settings slider spans roughly 0.15 s to 5 s, so a value outside that
// band means the unit conversion is wrong, not that the user chose it.
func TestSystemDoubleClickIntervalIsInSeconds(t *testing.T) {
	d := systemDoubleClickInterval()
	if d < 100*time.Millisecond || d > maxDoubleClickInterval {
		t.Fatalf("systemDoubleClickInterval() = %v, want between 100ms and %v", d, maxDoubleClickInterval)
	}
}
