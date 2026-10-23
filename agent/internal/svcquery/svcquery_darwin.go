//go:build darwin

package svcquery

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
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

// GetStatus queries a launchd service by label via `launchctl list`, falling
// back to the plist paths for an installed but unloaded job. A label that is
// neither listed nor installed wraps ErrServiceNotFound; a failed `launchctl
// list` does not (see resolveLaunchdStatus).
func GetStatus(name string) (ServiceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	output, err := exec.CommandContext(ctx, "launchctl", "list").Output()
	return resolveLaunchdStatus(string(output), err, name, func(p string) (bool, error) {
		_, statErr := os.Stat(p)
		if statErr == nil {
			return true, nil
		}
		if errors.Is(statErr, fs.ErrNotExist) {
			return false, nil
		}
		return false, statErr
	})
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
