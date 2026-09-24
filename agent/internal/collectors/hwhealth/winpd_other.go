//go:build !windows

package hwhealth

func newWinPD() Source {
	return unavailableSource("windows_physical_disk", TierDisk)
}
