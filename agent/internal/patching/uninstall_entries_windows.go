//go:build windows

package patching

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// Machine-wide Uninstall keys: the 64-bit view and the 32-bit (WOW6432Node)
// view. winget is listed with --scope machine and Chocolatey installs
// machine-wide, so per-user keys are not read.
var uninstallRegistryPaths = []string{
	`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
	`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
}

// platformUninstallEntries reads DisplayName, DisplayVersion and InstallDate
// from every machine-wide Uninstall key. A missing view (32-bit Windows has
// no WOW6432Node) is skipped. Any other failure returns an error and no
// entries, so a partial read cannot make an ambiguous name look unique.
func platformUninstallEntries() ([]uninstallEntry, error) {
	var entries []uninstallEntry
	for _, path := range uninstallRegistryPaths {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.READ)
		if err != nil {
			if errors.Is(err, registry.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("open HKLM\\%s: %w", path, err)
		}
		names, err := key.ReadSubKeyNames(-1)
		if err != nil {
			_ = key.Close()
			return nil, fmt.Errorf("list HKLM\\%s: %w", path, err)
		}
		for _, name := range names {
			sub, err := registry.OpenKey(key, name, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			entry := uninstallEntry{
				DisplayName:    registryString(sub, "DisplayName"),
				DisplayVersion: registryString(sub, "DisplayVersion"),
				InstallDate:    registryString(sub, "InstallDate"),
			}
			_ = sub.Close()
			if entry.DisplayName != "" {
				entries = append(entries, entry)
			}
		}
		_ = key.Close()
	}
	return entries, nil
}

func registryString(key registry.Key, name string) string {
	val, _, err := key.GetStringValue(name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(val)
}
