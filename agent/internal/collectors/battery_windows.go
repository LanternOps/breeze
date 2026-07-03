//go:build windows

package collectors

import (
	"log/slog"
	"unsafe"

	"golang.org/x/sys/windows"
)

// winSystemPowerStatus mirrors the Win32 SYSTEM_POWER_STATUS struct.
type winSystemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

var (
	batteryKernel32              = windows.NewLazySystemDLL("kernel32.dll")
	procBatteryGetSystemPowerSts = batteryKernel32.NewProc("GetSystemPowerStatus")
)

// collectPlatformBattery reads current power state via GetSystemPowerStatus — a
// cheap kernel32 syscall (no WMI/PowerShell spawn), so it's safe to call every
// heartbeat.
func collectPlatformBattery() *BatteryInfo {
	var status winSystemPowerStatus
	r, _, err := procBatteryGetSystemPowerSts.Call(uintptr(unsafe.Pointer(&status)))
	if r == 0 {
		slog.Warn("GetSystemPowerStatus failed", "error", err.Error())
		return nil
	}
	return mapWindowsPowerStatus(
		status.ACLineStatus,
		status.BatteryFlag,
		status.BatteryLifePercent,
		status.BatteryLifeTime,
	)
}
