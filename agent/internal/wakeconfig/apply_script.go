package wakeconfig

import (
	"fmt"
	"regexp"
	"strings"
)

// NIC write scripts. They live in an untagged file, apart from the read-only
// readScript, so the guarantees below are tested on every OS:
//   - the adapter is re-resolved by MAC on the same wired filter the read uses,
//     and the script refuses unless exactly one adapter matches;
//   - every Set-NetAdapter* call passes -NoRestart, so the link never drops;
//   - settings are matched by RegistryKeyword, never a localised display name;
//   - the only value interpolated is a MAC Go has parsed and re-formatted.
//
// `-NoRestart` on Set-NetAdapterPowerManagement and
// Set-NetAdapterAdvancedProperty was confirmed on Windows 11 26200 (read-only
// Get-Command probe on the lab Dell). The Realtek keyword S5WakeOnLan comes
// from community sources, not a captured Realtek driver; a driver without it
// reads as absent, so it is never written.
const nicWritePrelude = `$ErrorActionPreference='Stop'
$n=@(Get-NetAdapter -Physical | Where-Object { $_.NdisPhysicalMedium -eq 14 -and $_.MacAddress -eq '%s' })
if ($n.Count -ne 1) { throw 'expected exactly one wired adapter with this MAC' }
$name=[string]$n[0].Name
`

var nicWriteCommands = map[OpKind]string{
	OpMagicPacketOn:  `Set-NetAdapterPowerManagement -Name $name -WakeOnMagicPacket Enabled -NoRestart`,
	OpEEEOff:         `Set-NetAdapterAdvancedProperty -Name $name -RegistryKeyword '*EEE' -RegistryValue 0 -NoRestart`,
	OpShutdownWakeOn: `Set-NetAdapterAdvancedProperty -Name $name -RegistryKeyword 'S5WakeOnLan' -RegistryValue 1 -NoRestart`,
}

var psMACPattern = regexp.MustCompile(`^[0-9A-F]{2}(-[0-9A-F]{2}){5}$`)

// psMAC formats a MAC the way Get-NetAdapter reports it (AA-BB-CC-DD-EE-FF).
func psMAC(mac string) (string, error) {
	norm, ok := normaliseMAC(mac)
	if !ok {
		return "", fmt.Errorf("invalid adapter MAC")
	}
	out := strings.ToUpper(strings.ReplaceAll(norm, ":", "-"))
	if !psMACPattern.MatchString(out) {
		return "", fmt.Errorf("invalid adapter MAC")
	}
	return out, nil
}

// writeScript returns the PowerShell for one NIC write. Fast Startup is a
// registry write in Go and has no script.
func writeScript(op Op) (string, error) {
	cmd, ok := nicWriteCommands[op.Kind]
	if !ok {
		return "", fmt.Errorf("no script for %v", op.Kind)
	}
	mac, err := psMAC(op.MAC)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(nicWritePrelude, mac) + cmd, nil
}
