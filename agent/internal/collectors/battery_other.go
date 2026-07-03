//go:build !windows && !linux && !darwin

package collectors

// collectPlatformBattery is unsupported on this platform (BSD, etc.). Returning
// nil makes the heartbeat omit the battery field, so the server keeps whatever
// it last knew rather than clobbering it with a bogus snapshot.
func collectPlatformBattery() *BatteryInfo { return nil }
