//go:build windows

package heartbeat

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

// readPromptOnSecureDesktop reads HKLM\SOFTWARE\Microsoft\Windows\
// CurrentVersion\Policies\System\PromptOnSecureDesktop.
func readPromptOnSecureDesktop() (bool, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return secureDesktopFromValue(0, errSecureDesktopValueMissing)
	}
	if err != nil {
		return secureDesktopFromValue(0, err)
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetIntegerValue("PromptOnSecureDesktop")
	if errors.Is(err, registry.ErrNotExist) {
		err = errSecureDesktopValueMissing
	}
	return secureDesktopFromValue(v, err)
}
