//go:build darwin

package collectors

import (
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
)

func collectServices() ([]ServiceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "launchctl", "list")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("launchctl list failed: %w", err)
	}

	var services []ServiceInfo
	for _, rawLine := range strings.Split(string(output), "\n") {
		line := strings.TrimSpace(rawLine)
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
			Name:        label,
			DisplayName: label,
			State:       state,
			StartupType: "loaded",
		})
	}

	sort.Slice(services, func(i, j int) bool {
		return services[i].Name < services[j].Name
	})
	return services, nil
}
