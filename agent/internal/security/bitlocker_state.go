package security

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"
)

// System-drive BitLocker states. "suspended" is an encrypted volume whose
// protection is off: a firmware update suspends it and the next boot resumes it.
const (
	BitLockerStateOn        = "on"
	BitLockerStateSuspended = "suspended"
	BitLockerStateOff       = "off"
	BitLockerStateUnknown   = "unknown"
)

// bitLockerSystemDriveStatePS prints "VolumeStatus|ProtectionStatus" for the OS
// volume. [string] gives enum names on PowerShell 5.1; the parser also takes
// the numeric values.
const bitLockerSystemDriveStatePS = `$v = Get-BitLockerVolume -MountPoint $env:SystemDrive; "$([string]$v.VolumeStatus)|$([string]$v.ProtectionStatus)"`

// SystemDriveBitLockerState is a fresh read of the OS volume's BitLocker state.
// A host without BitLocker is "off" with ErrBitLockerUnavailable and spawns
// nothing. Any other failure is "unknown" with the error: callers that gate a
// firmware install on it must treat that as on.
func SystemDriveBitLockerState() (string, error) {
	return systemDriveBitLockerStateFor(runtime.GOOS)
}

func systemDriveBitLockerStateFor(goos string) (string, error) {
	if goos != "windows" {
		return BitLockerStateUnknown, errors.New("bitlocker state is only read on windows")
	}
	if bitLockerNotInstalled() {
		return BitLockerStateOff, ErrBitLockerUnavailable
	}
	out, err := runBitLockerPowerShell(10*time.Second, bitLockerSystemDriveStatePS)
	if err != nil {
		return BitLockerStateUnknown, err
	}
	return parseSystemDriveBitLockerState(out)
}

func parseSystemDriveBitLockerState(out string) (string, error) {
	volume, protection, ok := strings.Cut(strings.TrimSpace(out), "|")
	if !ok {
		return BitLockerStateUnknown, fmt.Errorf("unexpected bitlocker state output %q", strings.TrimSpace(out))
	}
	volume = strings.ToLower(strings.TrimSpace(volume))
	protection = strings.ToLower(strings.TrimSpace(protection))

	var encrypted bool
	switch volume {
	case "fullydecrypted", "0":
		encrypted = false
	case "fullyencrypted", "encryptioninprogress", "decryptioninprogress", "encryptionpaused", "decryptionpaused",
		"1", "2", "3", "4", "5":
		encrypted = true
	default:
		return BitLockerStateUnknown, fmt.Errorf("unexpected bitlocker volume status %q", volume)
	}
	switch protection {
	case "on", "1":
		if !encrypted {
			return BitLockerStateUnknown, errors.New("bitlocker protection on for a decrypted volume")
		}
		return BitLockerStateOn, nil
	case "off", "0":
		if encrypted {
			return BitLockerStateSuspended, nil
		}
		return BitLockerStateOff, nil
	default:
		return BitLockerStateUnknown, fmt.Errorf("unexpected bitlocker protection status %q", protection)
	}
}
