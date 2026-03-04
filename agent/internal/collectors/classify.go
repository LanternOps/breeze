package collectors

import "strings"

// ClassifyDeviceRole determines the device role from system info and hardware data.
func ClassifyDeviceRole(sysInfo *SystemInfo, hw *HardwareInfo) string {
	// 1. Chassis type (DMI SMBIOS codes)
	if hw != nil && hw.ChassisType != "" {
		switch hw.ChassisType {
		case "3", "4", "6", "7", "13", "35", // Desktop, Low-Profile Desktop, Mini Tower, Tower, All-in-One, Mini PC
			"8", "9", "10", "14",            // Portable, Laptop, Notebook, Sub-Notebook
			"31", "32", "30":                 // Convertible, Detachable, Tablet
			return "workstation"
		case "17", "23", "28", "29": // Rack Mount Chassis, Main Server, Blade, Blade Enclosure
			return "server"
		case "11": // Hand Held
			return "phone"
		}
	}

	// 2. Model name heuristics
	if hw != nil {
		model := strings.ToLower(hw.Model)
		for _, kw := range []string{"poweredge", "proliant", "primergy", "system x"} {
			if strings.Contains(model, kw) {
				return "server"
			}
		}
		for _, kw := range []string{"synology", "qnap", "readynas"} {
			if strings.Contains(model, kw) {
				return "nas"
			}
		}
		for _, kw := range []string{"fortigate", "pfsense"} {
			if strings.Contains(model, kw) {
				return "firewall"
			}
		}
	}

	// 3. OS edition: Windows Server
	if sysInfo != nil && strings.Contains(strings.ToLower(sysInfo.OSVersion), "server") {
		return "server"
	}

	return "workstation"
}
