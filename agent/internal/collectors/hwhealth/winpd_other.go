//go:build !windows

package hwhealth

func newWinPD(map[string]string) Source {
	return unavailableSource("windows_physical_disk", TierDisk)
}
