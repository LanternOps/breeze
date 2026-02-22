//go:build linux

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

	unitFilesCmd := exec.CommandContext(
		ctx,
		"systemctl",
		"list-unit-files",
		"--type=service",
		"--no-legend",
		"--no-pager",
		"--plain",
	)
	unitFilesOut, err := unitFilesCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("systemctl list-unit-files failed: %w", err)
	}

	unitsCmd := exec.CommandContext(
		ctx,
		"systemctl",
		"list-units",
		"--type=service",
		"--all",
		"--no-legend",
		"--no-pager",
		"--plain",
	)
	unitsOut, err := unitsCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("systemctl list-units failed: %w", err)
	}

	startupByUnit := parseLinuxUnitFileStates(string(unitFilesOut))
	stateByUnit := parseLinuxRuntimeStates(string(unitsOut))

	unitNames := make(map[string]struct{}, len(startupByUnit)+len(stateByUnit))
	for unit := range startupByUnit {
		unitNames[unit] = struct{}{}
	}
	for unit := range stateByUnit {
		unitNames[unit] = struct{}{}
	}

	services := make([]ServiceInfo, 0, len(unitNames))
	for unit := range unitNames {
		name := strings.TrimSuffix(unit, ".service")
		services = append(services, ServiceInfo{
			Name:        name,
			DisplayName: name,
			State:       stateByUnit[unit],
			StartupType: startupByUnit[unit],
		})
	}

	sort.Slice(services, func(i, j int) bool {
		return services[i].Name < services[j].Name
	})
	return services, nil
}

func parseLinuxUnitFileStates(output string) map[string]string {
	result := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}

		unit := strings.TrimSpace(fields[0])
		if unit == "" || !strings.HasSuffix(unit, ".service") {
			continue
		}

		state := strings.ToLower(strings.TrimSpace(fields[1]))
		switch state {
		case "enabled", "enabled-runtime":
			result[unit] = "automatic"
		case "disabled", "masked":
			result[unit] = "disabled"
		case "static", "indirect", "generated", "transient", "linked", "linked-runtime", "alias":
			result[unit] = "manual"
		default:
			if state == "" {
				result[unit] = "unknown"
			} else {
				result[unit] = state
			}
		}
	}
	return result
}

func parseLinuxRuntimeStates(output string) map[string]string {
	result := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 4 {
			continue
		}

		unit := strings.TrimSpace(fields[0])
		if unit == "" || !strings.HasSuffix(unit, ".service") {
			continue
		}

		activeState := strings.ToLower(strings.TrimSpace(fields[2]))
		subState := strings.ToLower(strings.TrimSpace(fields[3]))
		switch activeState {
		case "active":
			result[unit] = "running"
		case "activating":
			result[unit] = "starting"
		case "deactivating":
			result[unit] = "stopping"
		case "failed":
			result[unit] = "failed"
		case "inactive":
			if subState == "dead" || subState == "" {
				result[unit] = "stopped"
			} else {
				result[unit] = subState
			}
		default:
			if activeState == "" {
				result[unit] = "unknown"
			} else {
				result[unit] = activeState
			}
		}
	}
	return result
}
