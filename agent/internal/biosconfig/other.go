//go:build !windows

package biosconfig

// newDellAdapter: Dell's native BIOS WMI exists only on Windows.
func newDellAdapter() Adapter {
	return nil
}
