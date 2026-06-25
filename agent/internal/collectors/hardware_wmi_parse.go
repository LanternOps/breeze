package collectors

import (
	"bytes"
	"encoding/json"
)

// gpuNameList is the GPU-name field of the batched WMI query. It exists to
// tolerate both shapes Windows can emit: a JSON array ("GPUNames":["a","b"])
// and — critically — a bare scalar string. Windows PowerShell 5.1 (the default
// shell on essentially every managed endpoint) collapses a single-element array
// to a scalar during ConvertTo-Json, so a one-GPU host (the common case) emits
// "GPUNames":"Intel UHD" rather than ["Intel UHD"]. Decoding straight into a
// []string would fail on those hosts and, because the caller treats any parse
// error as fatal, would drop the entire hardware record (serial, model, …).
type gpuNameList []string

// UnmarshalJSON accepts a JSON array, a bare string, or null/empty.
func (g *gpuNameList) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		*g = nil
		return nil
	}
	if trimmed[0] == '[' {
		var many []string
		if err := json.Unmarshal(trimmed, &many); err != nil {
			return err
		}
		*g = many
		return nil
	}
	var one string
	if err := json.Unmarshal(trimmed, &one); err != nil {
		return err
	}
	*g = []string{one}
	return nil
}

// windowsHardwareJSON is the shape emitted by the batched WMI PowerShell query
// in collectPlatformHardware. It lives in a build-tag-free file so the parser
// and its tests can run cross-platform (darwin/linux CI).
type windowsHardwareJSON struct {
	BiosSerial        string      `json:"BiosSerial"`
	BiosVersion       string      `json:"BiosVersion"`
	BoardSerial       string      `json:"BoardSerial"`
	BoardManufacturer string      `json:"BoardManufacturer"`
	BoardProduct      string      `json:"BoardProduct"`
	BoardVersion      string      `json:"BoardVersion"`
	SysManufacturer   string      `json:"SysManufacturer"`
	SysModel          string      `json:"SysModel"`
	GPUNames          gpuNameList `json:"GPUNames"`
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
