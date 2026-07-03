//go:build linux

package collectors

// collectPlatformBattery reads /sys/class/power_supply/*. The traversal +
// parsing lives in collectBatteryFromSysfs (battery.go, build-tag-free) so it
// unit-tests on any platform against a fixture directory.
func collectPlatformBattery() *BatteryInfo {
	return collectBatteryFromSysfs(powerSupplyRoot)
}
