//go:build darwin

package collectors

import (
	"bufio"
	"bytes"
	"fmt"
	"sort"
	"strings"
)

func collectServices() ([]ServiceInfo, error) {
	output, err := runCollectorOutput(collectorShortCommandTimeout, "launchctl", "list")
	if err != nil {
		return nil, fmt.Errorf("launchctl list failed: %w", err)
	}

	var services []ServiceInfo
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), collectorScannerLimit)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] == "PID" {
			continue
		}

		label := fields[2]
		state := "stopped"
		if fields[0] != "-" {
			state = "running"
		}

		services = append(services, ServiceInfo{
			Name:        truncateCollectorString(label),
			DisplayName: truncateCollectorString(label),
			State:       state,
			StartupType: "loaded",
		})
		if len(services) >= collectorResultLimit {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("launchctl list parse failed: %w", err)
	}

	sort.Slice(services, func(i, j int) bool {
		return services[i].Name < services[j].Name
	})
	return services, nil
}
