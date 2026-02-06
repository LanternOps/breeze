package collectors

import (
	"encoding/json"
	"os/exec"
	"strings"
)

// system_profiler JSON structures
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
}

type spDisplaysDataType struct {
	SPDisplaysDataType []spDisplayEntry `json:"SPDisplaysDataType"`
}

type spDisplayEntry struct {
	ChipsetModel string `json:"sppci_model"`
	// Apple Silicon reports GPU via chip_type in hardware, but discrete GPUs show here
}

func collectPlatformHardware(hw *HardwareInfo) {
	// Always Apple on macOS
	hw.Manufacturer = "Apple"

	// Get hardware details via system_profiler JSON output
	out, err := exec.Command("system_profiler", "SPHardwareDataType", "-json").Output()
	if err == nil {
		var data spHardwareDataType
		if json.Unmarshal(out, &data) == nil && len(data.SPHardwareDataType) > 0 {
			entry := data.SPHardwareDataType[0]
			hw.SerialNumber = entry.SerialNumber
			if entry.ModelName != "" {
				hw.Model = entry.ModelName
			} else if entry.MachineName != "" {
				hw.Model = entry.MachineName
			}
			hw.BIOSVersion = entry.BootROMVer
			// On Apple Silicon, the chip_type is the GPU (e.g. "Apple M1")
			if entry.ChipType != "" && hw.GPUModel == "" {
				hw.GPUModel = entry.ChipType
			}
		}
	}

	// Get GPU info from displays data
	out, err = exec.Command("system_profiler", "SPDisplaysDataType", "-json").Output()
	if err == nil {
		var data spDisplaysDataType
		if json.Unmarshal(out, &data) == nil && len(data.SPDisplaysDataType) > 0 {
			chipset := data.SPDisplaysDataType[0].ChipsetModel
			if chipset != "" {
				hw.GPUModel = chipset
			}
		}
	}

	// Fallback: use sysctl for model identifier if not set
	if hw.Model == "" {
		out, err = exec.Command("sysctl", "-n", "hw.model").Output()
		if err == nil {
			hw.Model = strings.TrimSpace(string(out))
		}
	}
}
