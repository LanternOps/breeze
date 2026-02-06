//go:build darwin

package collectors

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const darwinCmdTimeout = 15 * time.Second

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
}

func collectPlatformHardware(hw *HardwareInfo) {
	hw.Manufacturer = "Apple"

	ctx, cancel := context.WithTimeout(context.Background(), darwinCmdTimeout)
	defer cancel()

	// Get hardware details via system_profiler JSON output
	out, err := exec.CommandContext(ctx, "system_profiler", "SPHardwareDataType", "-json").Output()
	if err != nil {
		fmt.Printf("Warning: system_profiler SPHardwareDataType failed: %v\n", err)
	} else {
		var data spHardwareDataType
		if unmarshalErr := json.Unmarshal(out, &data); unmarshalErr != nil {
			fmt.Printf("Warning: failed to parse SPHardwareDataType JSON: %v\n", unmarshalErr)
		} else if len(data.SPHardwareDataType) > 0 {
			entry := data.SPHardwareDataType[0]
			hw.SerialNumber = entry.SerialNumber
			if entry.ModelName != "" {
				hw.Model = entry.ModelName
			} else if entry.MachineName != "" {
				hw.Model = entry.MachineName
			}
			hw.BIOSVersion = entry.BootROMVer
			if entry.ChipType != "" && hw.GPUModel == "" {
				hw.GPUModel = entry.ChipType
			}
		}
	}

	// Get GPU info from displays data (use separate timeout)
	ctx2, cancel2 := context.WithTimeout(context.Background(), darwinCmdTimeout)
	defer cancel2()

	out, err = exec.CommandContext(ctx2, "system_profiler", "SPDisplaysDataType", "-json").Output()
	if err != nil {
		fmt.Printf("Warning: system_profiler SPDisplaysDataType failed: %v\n", err)
	} else {
		var data spDisplaysDataType
		if unmarshalErr := json.Unmarshal(out, &data); unmarshalErr != nil {
			fmt.Printf("Warning: failed to parse SPDisplaysDataType JSON: %v\n", unmarshalErr)
		} else if len(data.SPDisplaysDataType) > 0 {
			chipset := data.SPDisplaysDataType[0].ChipsetModel
			if chipset != "" {
				hw.GPUModel = chipset
			}
		}
	}

	// Fallback: use sysctl for model identifier if not set
	if hw.Model == "" {
		out, err = exec.Command("sysctl", "-n", "hw.model").Output()
		if err != nil {
			fmt.Printf("Warning: sysctl hw.model failed: %v\n", err)
		} else {
			hw.Model = strings.TrimSpace(string(out))
		}
	}
}
