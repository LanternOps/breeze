//go:build windows

package collectors

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
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

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("service collection failed: %w", err)
	}

	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" || trimmed == "null" {
		return []ServiceInfo{}, nil
	}

	var rows []windowsServiceInfo
	if err := json.Unmarshal([]byte(trimmed), &rows); err != nil {
		var single windowsServiceInfo
		if errSingle := json.Unmarshal([]byte(trimmed), &single); errSingle != nil {
			return nil, fmt.Errorf("failed to parse service JSON: %w", err)
		}
		rows = []windowsServiceInfo{single}
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
	}

	sort.Slice(services, func(i, j int) bool {
		return services[i].Name < services[j].Name
	})
	return services, nil
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
