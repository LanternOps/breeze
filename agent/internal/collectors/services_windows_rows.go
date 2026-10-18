package collectors

// This file intentionally carries no build constraint ("rows" is not a
// GOOS/GOARCH, so Go's filename matching does not apply) so the conversion of
// Win32_Service CIM rows can be unit-tested on macOS/Linux CI.

import "strings"

// windowsServiceInfo is one row of
// `Get-CimInstance Win32_Service | Select-Object ... | ConvertTo-Json`.
type windowsServiceInfo struct {
	Name        string `json:"Name"`
	DisplayName string `json:"DisplayName"`
	State       string `json:"State"`
	StartMode   string `json:"StartMode"`
	StartName   string `json:"StartName"`
}

// windowsServiceFromRow converts a CIM row into a ServiceInfo. It returns
// false for rows without a usable service name.
//
// Control characters are stripped from every field. When the raw account or
// start mode contained any, the field is also flagged unreliable so the change
// tracker can keep its previous value (#8904). The NULs arrive in the CIM
// string itself: ConvertTo-Json escapes them as \u0000 and encoding/json
// decodes them back, so nothing on the agent's decode path introduces them.
func windowsServiceFromRow(row windowsServiceInfo) (ServiceInfo, bool) {
	info := sanitizeWindowsServiceInfo(ServiceInfo{
		Name:        row.Name,
		DisplayName: row.DisplayName,
		State:       normalizeWindowsServiceState(row.State),
		StartupType: normalizeWindowsStartupType(row.StartMode),
		Account:     row.StartName,
	})
	if info.Name == "" {
		return ServiceInfo{}, false
	}
	info.accountUnreliable = hasCollectorControlChars(row.StartName)
	info.startupTypeUnreliable = hasCollectorControlChars(row.StartMode)
	return info, true
}

func sanitizeWindowsServiceInfo(info ServiceInfo) ServiceInfo {
	info.Name = truncateCollectorString(info.Name)
	info.DisplayName = truncateCollectorString(info.DisplayName)
	info.State = truncateCollectorString(info.State)
	info.StartupType = truncateCollectorString(info.StartupType)
	info.Account = truncateCollectorString(info.Account)
	return info
}

func normalizeWindowsServiceState(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "running":
		return "running"
	case "stopped":
		return "stopped"
	case "paused":
		return "paused"
	case "start pending", "continue pending":
		return "starting"
	case "stop pending", "pause pending":
		return "stopping"
	case "unknown":
		return "unknown"
	default:
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "" {
			return "unknown"
		}
		return normalized
	}
}

func normalizeWindowsStartupType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "auto":
		return "automatic"
	case "manual":
		return "manual"
	case "disabled":
		return "disabled"
	default:
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "" {
			return "unknown"
		}
		return normalized
	}
}
