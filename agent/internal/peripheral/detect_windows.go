//go:build windows

package peripheral

import (
	"encoding/json"
	"os/exec"
	"strings"
)

type wmiPnPEntity struct {
	Name         string `json:"Name"`
	Manufacturer string `json:"Manufacturer"`
	DeviceID     string `json:"DeviceID"`
	PNPClass     string `json:"PNPClass"`
	Service      string `json:"Service"`
	Status       string `json:"Status"`
}

// DetectPeripherals enumerates USB and Bluetooth PnP devices via WMI on Windows.
func DetectPeripherals() ([]DetectedPeripheral, error) {
	// Query USB and Bluetooth PnP devices via PowerShell/WMI
	ps := `Get-CimInstance Win32_PnPEntity | ` +
		`Where-Object { $_.DeviceID -match '^USB\\' -or $_.DeviceID -match '^BTHENUM\\' -or $_.DeviceID -match '^USBSTOR\\' } | ` +
		`Select-Object Name, Manufacturer, DeviceID, PNPClass, Service, Status | ` +
		`ConvertTo-Json -Compress`

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	if len(strings.TrimSpace(string(output))) == 0 {
		return nil, nil
	}

	// PowerShell returns a single object (not array) when there's only one result
	var entities []wmiPnPEntity
	if err := json.Unmarshal(output, &entities); err != nil {
		var single wmiPnPEntity
		if err2 := json.Unmarshal(output, &single); err2 != nil {
			return nil, err
		}
		entities = []wmiPnPEntity{single}
	}

	result := make([]DetectedPeripheral, 0, len(entities))
	for _, e := range entities {
		if e.Name == "" {
			continue
		}
		pType, dClass := classifyWindows(e.DeviceID, e.PNPClass, e.Service)
		result = append(result, DetectedPeripheral{
			PeripheralType: pType,
			Vendor:         e.Manufacturer,
			Product:        e.Name,
			DeviceClass:    dClass,
			DeviceID:       e.DeviceID,
		})
	}
	return result, nil
}

// classifyWindows determines peripheral type and device class from WMI fields.
func classifyWindows(deviceID, pnpClass, service string) (peripheralType, deviceClass string) {
	upper := strings.ToUpper(deviceID)

	if strings.HasPrefix(upper, "BTHENUM\\") {
		return "bluetooth", "bluetooth"
	}

	if strings.HasPrefix(upper, "USBSTOR\\") {
		return "usb", "storage"
	}

	// Check service name for mass storage
	svc := strings.ToLower(service)
	if svc == "usbstor" || svc == "disk" {
		return "usb", "storage"
	}

	return "usb", "all_usb"
}
