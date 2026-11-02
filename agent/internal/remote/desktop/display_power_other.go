//go:build !darwin || !cgo

package desktop

// noDisplayPower is the display-power seam on platforms without it: every
// reading is unknown and every call is unsupported, so sessions behave exactly
// as they did before #10874.
type noDisplayPower struct{}

func newPlatformDisplayPower() displayPowerOps { return noDisplayPower{} }

func (noDisplayPower) counts() (displayCounts, bool) { return displayCounts{}, false }

func (noDisplayPower) declareUserActivity() error { return errDisplayPowerUnsupported }

func (noDisplayPower) preventDisplaySleep() (func() error, error) {
	return nil, errDisplayPowerUnsupported
}
