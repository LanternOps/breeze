//go:build linux

package tools

import (
	"bufio"
	"fmt"
	"os/exec"
	"strings"
)

func listServicesOS(search, statusFilter string) ([]ServiceInfo, error) {
	// Use systemctl to list all services
	cmd := exec.Command("systemctl", "list-units", "--type=service", "--all", "--no-pager", "--plain")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to list services: %w", err)
	}

	var services []ServiceInfo
	searchLower := strings.ToLower(search)
	scanner := bufio.NewScanner(strings.NewReader(string(output)))

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, "UNIT") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}

		name := strings.TrimSuffix(fields[0], ".service")
		status := "Unknown"
		if len(fields) > 3 {
			switch fields[3] {
			case "running":
				status = "Running"
			case "exited", "dead":
				status = "Stopped"
			case "failed":
				status = "Failed"
			default:
				status = fields[3]
			}
		}

		info := ServiceInfo{
			Name:        name,
			DisplayName: name,
			Status:      status,
			StartupType: getServiceStartType(name),
		}

		// Apply search filter
		if search != "" && !strings.Contains(strings.ToLower(info.Name), searchLower) {
			continue
		}

		// Apply status filter
		if statusFilter != "" && !strings.EqualFold(info.Status, statusFilter) {
			continue
		}

		services = append(services, info)
	}

	return services, nil
}

func getServiceOS(name string) (*ServiceInfo, error) {
	// Get service status
	cmd := exec.Command("systemctl", "show", name+".service",
		"--property=LoadState,ActiveState,SubState,Description,ExecStart")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("service not found: %w", err)
	}

	props := parseSystemctlProperties(string(output))

	status := "Unknown"
	switch props["ActiveState"] {
	case "active":
		status = "Running"
	case "inactive", "dead":
		status = "Stopped"
	case "failed":
		status = "Failed"
	default:
		status = props["ActiveState"]
	}

	return &ServiceInfo{
		Name:        name,
		DisplayName: name,
		Status:      status,
		StartupType: getServiceStartType(name),
		Description: props["Description"],
		Path:        props["ExecStart"],
	}, nil
}

func startServiceOS(name string) error {
	cmd := exec.Command("systemctl", "start", name+".service")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to start service: %w", err)
	}
	return nil
}

func stopServiceOS(name string) error {
	cmd := exec.Command("systemctl", "stop", name+".service")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to stop service: %w", err)
	}
	return nil
}

func restartServiceOS(name string) error {
	cmd := exec.Command("systemctl", "restart", name+".service")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart service: %w", err)
	}
	return nil
}

func getServiceStartType(name string) string {
	cmd := exec.Command("systemctl", "is-enabled", name+".service")
	output, _ := cmd.Output()
	result := strings.TrimSpace(string(output))

	switch result {
	case "enabled":
		return "Automatic"
	case "disabled":
		return "Disabled"
	case "masked":
		return "Disabled"
	default:
		return "Manual"
	}
}

func parseSystemctlProperties(output string) map[string]string {
	props := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			props[parts[0]] = parts[1]
		}
	}
	return props
}
