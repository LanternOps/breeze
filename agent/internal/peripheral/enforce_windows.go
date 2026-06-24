//go:build windows

package peripheral

import (
	"fmt"
	"os/exec"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	usbstorKeyPath = `SYSTEM\CurrentControlSet\Services\USBSTOR`
	usbstorValue   = "Start"
	usbstorBlock   = 4
	usbstorDefault = 3
	breezeManaged  = "BreezeManaged"

	removableStorageKey = `SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices\{53f5630d-b6bf-11d0-94f2-00a0c91efb8b}`
	denyWriteValue      = "Deny_Write"
)

type winEnforcer struct{}

func NewEnforcer() Enforcer { return winEnforcer{} }

func (winEnforcer) ApplyGate(class string, hasExceptions bool) EnforceOutcome {
	if hasExceptions {
		return EnforceOutcome{Mechanism: "per-device-only", Applied: true, Verified: true,
			Detail: "machine-wide gate skipped: policy has allow-exceptions"}
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, usbstorKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return EnforceOutcome{Mechanism: "usbstor-start", Detail: "open key: " + err.Error()}
	}
	defer k.Close()
	if err := k.SetDWordValue(usbstorValue, usbstorBlock); err != nil {
		return EnforceOutcome{Mechanism: "usbstor-start", Detail: "set Start: " + err.Error()}
	}
	_ = k.SetDWordValue(breezeManaged, 1)
	// Probe-verify.
	got, _, err := k.GetIntegerValue(usbstorValue)
	verified := err == nil && got == usbstorBlock
	return EnforceOutcome{Mechanism: "usbstor-start", Applied: true, Verified: verified,
		Detail: probeDetail(verified, "USBSTOR Start read-back mismatch")}
}

func (winEnforcer) RevertGate(class string) EnforceOutcome {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, usbstorKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return EnforceOutcome{Mechanism: "usbstor-start", Detail: "open key: " + err.Error()}
	}
	defer k.Close()
	// Only revert if WE set it (sentinel present), to avoid clobbering admin config.
	if managed, _, mErr := k.GetIntegerValue(breezeManaged); mErr != nil || managed != 1 {
		return EnforceOutcome{Mechanism: "usbstor-start", Applied: false, Verified: true,
			Detail: "not Breeze-managed; left untouched"}
	}
	if err := k.SetDWordValue(usbstorValue, usbstorDefault); err != nil {
		return EnforceOutcome{Mechanism: "usbstor-start", Detail: "restore Start: " + err.Error()}
	}
	_ = k.DeleteValue(breezeManaged)
	return EnforceOutcome{Mechanism: "usbstor-start", Applied: false, Verified: true}
}

func (winEnforcer) DisableDevice(instanceID string) EnforceOutcome {
	cmd := exec.Command("pnputil", "/remove-device", instanceID)
	if out, err := cmd.CombinedOutput(); err != nil {
		removeErr := err
		removeOut := strings.TrimSpace(string(out))
		cmd = exec.Command("pnputil", "/disable-device", instanceID)
		if out, err = cmd.CombinedOutput(); err != nil {
			return EnforceOutcome{Mechanism: "pnputil", Applied: false, Verified: false,
				Detail: fmt.Sprintf("pnputil remove: %v: %s; disable: %v: %s",
					removeErr, removeOut, err, strings.TrimSpace(string(out)))}
		}
	}
	// Probe: device should no longer enumerate as present (removed) or report disabled.
	probe := exec.Command("pnputil", "/enum-devices", "/instanceid", instanceID)
	pout, err := probe.CombinedOutput()
	normalized := strings.Join(strings.Fields(strings.ToLower(string(pout))), " ")
	verified := err != nil || !(strings.Contains(normalized, "status: started") ||
		strings.Contains(normalized, "status: running"))
	return EnforceOutcome{Mechanism: "pnputil", Applied: true, Verified: verified,
		Detail: probeDetail(verified, "device still reports started after remove")}
}

func (winEnforcer) ApplyReadOnly(class string) EnforceOutcome {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, removableStorageKey, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return EnforceOutcome{Mechanism: "removable-storage-deny-write", Detail: "create key: " + err.Error()}
	}
	defer k.Close()
	if err := k.SetDWordValue(denyWriteValue, 1); err != nil {
		return EnforceOutcome{Mechanism: "removable-storage-deny-write", Detail: "set Deny_Write: " + err.Error()}
	}
	got, _, err := k.GetIntegerValue(denyWriteValue)
	verified := err == nil && got == 1
	return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: true, Verified: verified,
		Detail: probeDetail(verified, "Deny_Write read-back mismatch (possible 2025 servicing regression)")}
}

func (winEnforcer) RevertReadOnly(class string) EnforceOutcome {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, removableStorageKey, registry.SET_VALUE)
	if err != nil {
		// Key absent == nothing to revert.
		return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: false, Verified: true}
	}
	_ = k.DeleteValue(denyWriteValue)
	_ = k.Close()
	k, err = registry.OpenKey(registry.LOCAL_MACHINE, removableStorageKey, registry.QUERY_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: false, Verified: true}
		}
		return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: false, Verified: false,
			Detail: "verify key: " + err.Error()}
	}
	defer k.Close()
	if _, _, err := k.GetIntegerValue(denyWriteValue); err == nil {
		return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: false, Verified: false,
			Detail: "Deny_Write still present after delete"}
	}
	return EnforceOutcome{Mechanism: "removable-storage-deny-write", Applied: false, Verified: true}
}

func probeDetail(verified bool, failMsg string) string {
	if verified {
		return ""
	}
	return failMsg
}
