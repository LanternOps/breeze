//go:build linux

package collectors

// linuxDMITablePath is the kernel's raw SMBIOS structure table export
// (root-readable). The table layout is version-independent, and the parser
// gates every field on the structure length, so smbios_entry_point is not
// needed.
const linuxDMITablePath = "/sys/firmware/dmi/tables/DMI"

func collectPlatformMemory() (*MemoryInfo, error) {
	table, err := readSMBIOSTableFile(linuxDMITablePath)
	if err != nil {
		return nil, err
	}
	return memoryInfoFromSMBIOSTable(table)
}
