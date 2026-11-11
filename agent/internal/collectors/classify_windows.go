//go:build windows

package collectors

// getChassisType reads the chassis type from the firmware's SMBIOS table, in
// process. wmic.exe is gone from Windows 11 24H2 and Server 2025.
func getChassisType() string {
	return chassisTypeFromSMBIOS(readRawSMBIOSTable)
}

// detectLinuxServer is a no-op on Windows.
func detectLinuxServer() bool {
	return false
}
