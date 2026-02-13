//go:build darwin

package svcquery

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// IsRunning returns true if the named service is loaded and running via launchctl.
func IsRunning(name string) (bool, error) {
	info, err := GetStatus(name)
	if err != nil {
		return false, err
	}
	return info.IsActive(), nil
}

// GetStatus queries a launchd service by label.
// Checks launchctl list for running status.
func GetStatus(name string) (ServiceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "launchctl", "list")
	output, err := cmd.Output()
	if err != nil {
		return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: launchctl list: %w", err)
	}

	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		label := fields[2]
		if label == name || strings.HasSuffix(label, "."+name) {
			pid := fields[0]
			info := ServiceInfo{
				Name:   label,
				Status: StatusStopped,
			}
			if pid != "-" {
				info.Status = StatusRunning
			}
			return info, nil
		}
	}

	// Not in launchctl list — check if plist exists (installed but not loaded)
	plistPaths := []string{
		"/Library/LaunchDaemons/" + name + ".plist",
		"/Library/LaunchAgents/" + name + ".plist",
	}
	for _, p := range plistPaths {
		if _, err := os.Stat(p); err == nil {
			return ServiceInfo{Name: name, Status: StatusStopped}, nil
		}
	}

	return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: service %s not found", name)
}

// ListServices returns all loaded launchd services.
func ListServices() ([]ServiceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "launchctl", "list")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("svcquery: launchctl list: %w", err)
	}

	var services []ServiceInfo
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		// Skip header
		if fields[0] == "PID" {
			continue
		}
		label := fields[2]
		status := StatusStopped
		if fields[0] != "-" {
			status = StatusRunning
		}
		services = append(services, ServiceInfo{
			Name:   label,
			Status: status,
		})
	}
	return services, nil
}
