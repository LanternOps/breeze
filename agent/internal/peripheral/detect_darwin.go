//go:build darwin

package peripheral

import (
	"encoding/json"
	"os/exec"
	"strings"
)

// spUSBDataType is the top-level JSON wrapper from system_profiler SPUSBDataType.
type spUSBDataType struct {
	SPUSBDataType []spUSBItem `json:"SPUSBDataType"`
}

type spUSBItem struct {
	Name         string      `json:"_name"`
	VendorID     string      `json:"vendor_id,omitempty"`
	ProductID    string      `json:"product_id,omitempty"`
	Manufacturer string      `json:"manufacturer,omitempty"`
	SerialNum    string      `json:"serial_num,omitempty"`
	Media        []spMedia   `json:"Media,omitempty"`
	Items        []spUSBItem `json:"_items,omitempty"`
}

type spMedia struct {
	Name string `json:"_name"`
}

// DetectPeripherals enumerates USB devices via system_profiler on macOS.
func DetectPeripherals() ([]DetectedPeripheral, error) {
	cmd := exec.Command("system_profiler", "SPUSBDataType", "-json")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var data spUSBDataType
	if err := json.Unmarshal(output, &data); err != nil {
		return nil, err
	}

	var result []DetectedPeripheral
	for _, item := range data.SPUSBDataType {
		collectUSBItems(item, &result)
	}
	return result, nil
}

func collectUSBItems(item spUSBItem, out *[]DetectedPeripheral) {
	// Skip hub entries (they have sub-items but no useful info)
	if item.Name != "" && !isHub(item.Name) {
		devClass := "all_usb"
		if len(item.Media) > 0 {
			devClass = "storage"
		}

		vendor := item.Manufacturer
		if vendor == "" && item.VendorID != "" {
			vendor = item.VendorID
		}

		*out = append(*out, DetectedPeripheral{
			PeripheralType: "usb",
			Vendor:         vendor,
			Product:        item.Name,
			SerialNumber:   item.SerialNum,
			DeviceClass:    devClass,
			DeviceID:       strings.TrimSpace(item.VendorID + ":" + item.ProductID),
		})
	}

	// Recurse into child items (USB hubs contain nested devices)
	for _, child := range item.Items {
		collectUSBItems(child, out)
	}
}

func isHub(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "hub")
}
