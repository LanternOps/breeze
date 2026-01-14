//go:build darwin

package tools

import (
	"bufio"
	"fmt"
	"os/exec"
	"strings"
)

func listServicesOS(search, statusFilter string) ([]ServiceInfo, error) {
	// Use launchctl to list services
	cmd := exec.Command("launchctl", "list")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to list services: %w", err)
	}

	var services []ServiceInfo
	searchLower := strings.ToLower(search)
	scanner := bufio.NewScanner(strings.NewReader(string(output)))

	// Skip header line
	if scanner.Scan() {
		// Header: PID	Status	Label
	}

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}

		pid := fields[0]
		label := fields[len(fields)-1]

		status := "Stopped"
		if pid != "-" && pid != "0" {
			status = "Running"
		}

		info := ServiceInfo{
			Name:        label,
			DisplayName: label,
			Status:      status,
			StartupType: "Automatic", // launchd services are typically auto
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
	// Get service info using launchctl
	cmd := exec.Command("launchctl", "print", "system/"+name)
	output, err := cmd.Output()
	if err != nil {
		// Try user domain
		cmd = exec.Command("launchctl", "print", "gui/"+name)
		output, err = cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("service not found: %w", err)
		}
	}

	// Parse output for status
	status := "Unknown"
	if strings.Contains(string(output), "state = running") {
		status = "Running"
	} else if strings.Contains(string(output), "state = waiting") {
		status = "Stopped"
	}

	return &ServiceInfo{
		Name:        name,
		DisplayName: name,
		Status:      status,
		StartupType: "Automatic",
	}, nil
}

func startServiceOS(name string) error {
	// Try kickstart first (for launchd services)
	cmd := exec.Command("launchctl", "kickstart", "-k", "system/"+name)
	if err := cmd.Run(); err != nil {
		// Fall back to load
		cmd = exec.Command("launchctl", "load", "-w", fmt.Sprintf("/Library/LaunchDaemons/%s.plist", name))
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("failed to start service: %w", err)
		}
	}
	return nil
}

func stopServiceOS(name string) error {
	cmd := exec.Command("launchctl", "kill", "SIGTERM", "system/"+name)
	if err := cmd.Run(); err != nil {
		// Fall back to unload
		cmd = exec.Command("launchctl", "unload", fmt.Sprintf("/Library/LaunchDaemons/%s.plist", name))
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("failed to stop service: %w", err)
		}
	}
	return nil
}

func restartServiceOS(name string) error {
	if err := stopServiceOS(name); err != nil {
		// Service might not be running, continue with start
	}
	return startServiceOS(name)
}
