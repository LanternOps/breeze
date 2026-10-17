package systemrestore

import (
	"errors"
	"fmt"
)

// Registry locations and rules for System Restore state. The decisions are
// here, platform-neutral, so they are tested on every OS; verify_windows.go
// supplies only the raw reader.
const (
	srConfigKey = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore`
	srPolicyKey = `SOFTWARE\Policies\Microsoft\Windows NT\SystemRestore`

	// defaultFrequencyMinutes is Microsoft's documented default for
	// SystemRestorePointCreationFrequency when the value is absent.
	defaultFrequencyMinutes int64 = 1440
)

// errRegistryNotExist is what a registryReader returns when the key or value
// is absent. Any other error means the state is unknown.
var errRegistryNotExist = errors.New("registry key or value does not exist")

// registryReader reads an HKLM integer value.
type registryReader func(path, name string) (uint64, error)

// registryDisabled reports whether System Restore is switched off machine-wide
// by Group Policy or by the DisableSR configuration value. Absent keys mean
// "not disabled"; an unreadable value is an error, never a silent "enabled".
func registryDisabled(read registryReader) (bool, error) {
	for _, path := range []string{srPolicyKey, srConfigKey} {
		v, err := read(path, "DisableSR")
		switch {
		case errors.Is(err, errRegistryNotExist):
			continue
		case err != nil:
			return false, fmt.Errorf("reading %s\\DisableSR: %w", path, err)
		case v == 1:
			return true, nil
		}
	}
	return false, nil
}

// registryFrequency reads SystemRestorePointCreationFrequency in minutes.
// Absent means the Windows default; unreadable is an error, so the Outcome
// never states a frequency nobody read. Read only — Breeze never writes it
// (#4609 Open Decision 6).
func registryFrequency(read registryReader) (int64, error) {
	v, err := read(srConfigKey, "SystemRestorePointCreationFrequency")
	switch {
	case errors.Is(err, errRegistryNotExist):
		return defaultFrequencyMinutes, nil
	case err != nil:
		return 0, fmt.Errorf("reading SystemRestorePointCreationFrequency: %w", err)
	}
	return int64(v), nil
}
