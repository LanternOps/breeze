//go:build windows

package oemupdates

import (
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/patching"
)

// serviceStartDisabled is the SCM's SERVICE_DISABLED start type.
const serviceStartDisabled = 4

func systemSurfaceHost() surfaceHost {
	// No config: an update whose EULA is not accepted fails visibly and is not
	// accepted on anyone's behalf. W12 checks whether Surface updates carry one.
	provider := patching.NewWindowsUpdateProvider(nil)
	return surfaceHost{
		identity:        readSMBIOSIdentity,
		updatesDisabled: windowsUpdateDisabled,
		search:          provider.SearchDriverUpdates,
		install:         provider.InstallDriverUpdates,
		rebootPending:   detectPendingReboot,
		power:           systemPower{}.Status,
		guard:           ProductionGuardDeps(),
	}
}

// readSMBIOSIdentity reads the registry's copy of SMBIOS, without a spawn.
func readSMBIOSIdentity() (string, string, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, registry.QUERY_VALUE)
	if err != nil {
		return "", "", fmt.Errorf("open BIOS key: %w", err)
	}
	defer func() { _ = k.Close() }()
	maker, _, err := k.GetStringValue("SystemManufacturer")
	if err != nil {
		return "", "", fmt.Errorf("read SystemManufacturer: %w", err)
	}
	model, _, err := k.GetStringValue("SystemProductName")
	if err != nil {
		return "", "", fmt.Errorf("read SystemProductName: %w", err)
	}
	return strings.TrimSpace(maker), strings.TrimSpace(model), nil
}

// windowsUpdateDisabled reads the service's start type. Only "disabled" counts:
// wuauserv is normally stopped until it is used. An unreadable value is not
// "disabled", because the search then fails and says why.
func windowsUpdateDisabled() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\wuauserv`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer func() { _ = k.Close() }()
	start, _, err := k.GetIntegerValue("Start")
	return err == nil && start == serviceStartDisabled
}
