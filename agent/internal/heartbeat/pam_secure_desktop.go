package heartbeat

import "errors"

// errSecureDesktopValueMissing: PromptOnSecureDesktop (or its key) is not
// set, which means the Windows default.
var errSecureDesktopValueMissing = errors.New("PromptOnSecureDesktop is not set")

// secureDesktopFromValue maps the PromptOnSecureDesktop DWORD read to "UAC
// uses the secure desktop": 0 is off; any other value, or a missing value
// (the Windows default), is on. A read error also answers on (with the
// error): only the SYSTEM helper then asks, never a possibly hidden Assist.
// Untagged so CI tests it on every OS.
func secureDesktopFromValue(v uint64, err error) (bool, error) {
	if errors.Is(err, errSecureDesktopValueMissing) {
		return true, nil
	}
	if err != nil {
		return true, err
	}
	return v != 0, nil
}
