//go:build windows

package collectors

import (
	"context"
	"sort"
)

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
		info, ok := windowsServiceFromRow(row)
		if !ok {
			continue
		}
		services = append(services, info)
		if len(services) >= collectorResultLimit {
			break
		}
	}

	sort.Slice(services, func(i, j int) bool {
		return services[i].Name < services[j].Name
	})
	return services, nil
}
