package collectors

import "encoding/json"

// system_profiler SPHardwareDataType -json structures. They live in a
// build-tag-free file so the parser and its tests run on every CI platform.
type spHardwareDataType struct {
	SPHardwareDataType []spHardwareEntry `json:"SPHardwareDataType"`
}

type spHardwareEntry struct {
	SerialNumber string `json:"serial_number"`
	MachineName  string `json:"machine_name"`
	ModelName    string `json:"model_name"`
	ModelNumber  string `json:"model_number"`
	BootROMVer   string `json:"boot_rom_version"`
	ChipType     string `json:"chip_type"`
	// PlatformUUID is IOPlatformUUID, the SMBIOS-equivalent system UUID that
	// survives a macOS reinstall (#8318).
	PlatformUUID string `json:"platform_UUID"`
}

// parseSPHardwareJSON decodes `system_profiler SPHardwareDataType -json` and
// returns its first entry; ok is false when the output holds no entry.
func parseSPHardwareJSON(data []byte) (entry spHardwareEntry, ok bool, err error) {
	var parsed spHardwareDataType
	if err := json.Unmarshal(data, &parsed); err != nil {
		return spHardwareEntry{}, false, err
	}
	if len(parsed.SPHardwareDataType) == 0 {
		return spHardwareEntry{}, false, nil
	}
	return parsed.SPHardwareDataType[0], true, nil
}

// applySPHardwareEntry maps a parsed SPHardwareDataType entry onto hw.
func applySPHardwareEntry(hw *HardwareInfo, entry spHardwareEntry) {
	hw.SerialNumber = truncateCollectorString(entry.SerialNumber)
	if entry.ModelName != "" {
		hw.Model = truncateCollectorString(entry.ModelName)
	} else if entry.MachineName != "" {
		hw.Model = truncateCollectorString(entry.MachineName)
	}
	hw.BIOSVersion = truncateCollectorString(entry.BootROMVer)
	if entry.ChipType != "" && hw.GPUModel == "" {
		hw.GPUModel = truncateCollectorString(entry.ChipType)
	}
	hw.SystemUUID = normalizeSystemUUID(entry.PlatformUUID)
}
