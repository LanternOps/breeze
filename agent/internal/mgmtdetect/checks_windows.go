//go:build windows

package mgmtdetect

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

func (d *checkDispatcher) checkRegistryValue(path string) bool {
	parts := strings.SplitN(path, `\`, 2)
	if len(parts) < 2 {
		return false
	}
	hive := strings.ToUpper(parts[0])
	subPath := parts[1]

	var root registry.Key
	switch hive {
	case "HKLM", "HKEY_LOCAL_MACHINE":
		root = registry.LOCAL_MACHINE
	case "HKCU", "HKEY_CURRENT_USER":
		root = registry.CURRENT_USER
	default:
		return false
	}

	key, err := registry.OpenKey(root, subPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	key.Close()
	return true
}

func (d *checkDispatcher) checkLaunchDaemon(_ string) bool {
	return false
}
