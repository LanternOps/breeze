//go:build windows

package collectors

import (
	"context"
	"sort"
	"strings"
)

type windowsServiceInfo struct {
	Name        string `json:"Name"`
	DisplayName string `json:"DisplayName"`
	State       string `json:"State"`
	StartMode   string `json:"StartMode"`
	StartName   string `json:"StartName"`
}

func collectServices() ([]ServiceInfo, error) {
	psScript := `
Get-CimInstance -ClassName Win32_Service -ErrorAction Stop |
  Select-Object Name, DisplayName, State, StartMode, StartName |
  ConvertTo-Json -Compress -Depth 2
`

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	rows, err := runWindowsJSON[windowsServiceInfo](ctx, psScript)
	if err != nil {
		return nil, err
	}

	services := make([]ServiceInfo, 0, len(rows))
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		if name == "" {
			continue
		}
		services = append(services, ServiceInfo{
			Name:        name,
			DisplayName: strings.TrimSpace(row.DisplayName),
			State:       normalizeWindowsServiceState(row.State),
			StartupType: normalizeWindowsStartupType(row.StartMode),
			Account:     strings.TrimSpace(row.StartName),
		})
		services[len(services)-1] = sanitizeWindowsServiceInfo(services[len(services)-1])
		if len(services) >= collectorResultLimit {
			break
		}
	}

	sort.Slice(services, func(i, j int) bool {
		return services[i].Name < services[j].Name
	})
	return services, nil
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
