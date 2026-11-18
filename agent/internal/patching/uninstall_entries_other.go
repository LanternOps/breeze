//go:build !windows

package patching

// platformUninstallEntries has no Uninstall registry to read off Windows.
func platformUninstallEntries() ([]uninstallEntry, error) {
	return nil, nil
}
