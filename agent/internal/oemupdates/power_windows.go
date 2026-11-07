//go:build windows

package oemupdates

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// systemPowerStatus is SYSTEM_POWER_STATUS. patching reads the same struct for
// its AC preflight; this lane needs the battery fields too and keeps its own
// copy rather than exporting patching's.
type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

var procGetSystemPowerStatus = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetSystemPowerStatus")

type systemPower struct{}

func (systemPower) Status() (PowerStatus, error) {
	var s systemPowerStatus
	r, _, err := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&s)))
	if r == 0 {
		return PowerStatus{}, fmt.Errorf("GetSystemPowerStatus: %w", err)
	}
	return PowerStatus{ACLineStatus: s.ACLineStatus, BatteryFlag: s.BatteryFlag, BatteryLifePercent: s.BatteryLifePercent}, nil
}
