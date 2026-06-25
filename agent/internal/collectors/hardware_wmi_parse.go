package collectors

import "encoding/json"

// windowsHardwareJSON is the shape emitted by the batched WMI PowerShell query
// in collectPlatformHardware. It lives in a build-tag-free file so the parser
// and its tests can run cross-platform (darwin/linux CI).
type windowsHardwareJSON struct {
	BiosSerial        string   `json:"BiosSerial"`
	BiosVersion       string   `json:"BiosVersion"`
	BoardSerial       string   `json:"BoardSerial"`
	BoardManufacturer string   `json:"BoardManufacturer"`
	BoardProduct      string   `json:"BoardProduct"`
	BoardVersion      string   `json:"BoardVersion"`
	SysManufacturer   string   `json:"SysManufacturer"`
	SysModel          string   `json:"SysModel"`
	GPUNames          []string `json:"GPUNames"`
}

// parseHardwareJSON decodes the JSON output from the batched WMI query.
// Unknown fields are ignored; missing or null fields leave the zero value.
func parseHardwareJSON(data []byte) (windowsHardwareJSON, error) {
	var result windowsHardwareJSON
	if err := json.Unmarshal(data, &result); err != nil {
		return result, err
	}
	return result, nil
}
