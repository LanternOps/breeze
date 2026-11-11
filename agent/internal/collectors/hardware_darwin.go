//go:build darwin

package collectors

import (
	"encoding/json"
	"log/slog"
	"strings"
)

type spDisplaysDataType struct {
	SPDisplaysDataType []spDisplayEntry `json:"SPDisplaysDataType"`
}

type spDisplayEntry struct {
	ChipsetModel string `json:"sppci_model"`
}

func collectPlatformHardware(hw *HardwareInfo) {
	hw.Manufacturer = "Apple"

	// Get hardware details via system_profiler JSON output
	out, err := runCollectorOutput(collectorLongCommandTimeout, "system_profiler", "SPHardwareDataType", "-json")
	if err != nil {
		slog.Warn("system_profiler SPHardwareDataType failed", "error", err.Error())
	} else {
		entry, ok, parseErr := parseSPHardwareJSON(out)
		if parseErr != nil {
			slog.Warn("failed to parse SPHardwareDataType JSON", "error", parseErr.Error())
		} else if ok {
			applySPHardwareEntry(hw, entry)
		}
	}

	// Get GPU info from displays data.
	out, err = runCollectorOutput(collectorLongCommandTimeout, "system_profiler", "SPDisplaysDataType", "-json")
	if err != nil {
		slog.Warn("system_profiler SPDisplaysDataType failed", "error", err.Error())
	} else {
		var data spDisplaysDataType
		if unmarshalErr := json.Unmarshal(out, &data); unmarshalErr != nil {
			slog.Warn("failed to parse SPDisplaysDataType JSON", "error", unmarshalErr.Error())
		} else if len(data.SPDisplaysDataType) > 0 {
			chipset := data.SPDisplaysDataType[0].ChipsetModel
			if chipset != "" {
				hw.GPUModel = truncateCollectorString(chipset)
			}
		}
	}

	// Fallback: use sysctl for model identifier if not set
	if hw.Model == "" {
		out, err = runCollectorOutput(collectorShortCommandTimeout, "sysctl", "-n", "hw.model")
		if err != nil {
			slog.Warn("sysctl hw.model failed", "error", err.Error())
		} else {
			hw.Model = truncateCollectorString(strings.TrimSpace(string(out)))
		}
	}
}
