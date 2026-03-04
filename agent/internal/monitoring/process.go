package monitoring

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

// checkProcess looks for a process by name and reports its status + resource usage.
func checkProcess(name string, cpuThreshold, memThreshold float64) CheckResult {
	procs, err := process.Processes()
	if err != nil {
		return CheckResult{
			Status:  StatusError,
			Details: map[string]any{"error": err.Error()},
		}
	}

	for _, p := range procs {
		pName, err := p.Name()
		if err != nil {
			log.Warn("failed to read process name", "pid", p.Pid, "error", err.Error())
			continue
		}

		if !matchesProcessName(pName, name) {
			continue
		}

		result := CheckResult{
			Status: StatusRunning,
			Pid:    int(p.Pid),
		}

		// Collect CPU usage (instantaneous — based on cumulative CPU time, not averaged over an interval)
		cpu, err := p.CPUPercent()
		if err != nil {
			log.Warn("failed to read CPU percent for process", "name", name, "pid", p.Pid, "error", err.Error())
		} else {
			result.CpuPercent = cpu
		}

		// Collect memory usage
		memInfo, err := p.MemoryInfo()
		if err != nil {
			log.Warn("failed to read memory info for process", "name", name, "pid", p.Pid, "error", err.Error())
		} else if memInfo != nil {
			result.MemoryMb = float64(memInfo.RSS) / (1024 * 1024)
		}

		return result
	}

	return CheckResult{
		Status: StatusNotFound,
	}
}

// matchesProcessName checks if a running process name matches the watch pattern.
// Supports exact match and .exe-agnostic match (e.g., "nginx" matches "nginx.exe" on Windows).
func matchesProcessName(actual, pattern string) bool {
	actual = strings.ToLower(actual)
	pattern = strings.ToLower(pattern)

	if actual == pattern {
		return true
	}

	// Match without .exe suffix
	if strings.TrimSuffix(actual, ".exe") == strings.TrimSuffix(pattern, ".exe") {
		return true
	}

	return false
}

// killProcess kills a process by name. For processes managed by a service manager
// (systemd, launchd), the manager will typically respawn the process automatically.
// For unmanaged processes, this effectively stops them permanently — there is no
// spawn/re-launch logic here.
func killProcess(name string) error {
	procs, err := process.Processes()
	if err != nil {
		return fmt.Errorf("failed to list processes: %w", err)
	}

	var found bool
	for _, p := range procs {
		pName, err := p.Name()
		if err != nil {
			log.Warn("failed to read process name during kill scan", "pid", p.Pid, "error", err.Error())
			continue
		}
		if matchesProcessName(pName, name) {
			if err := p.Kill(); err != nil {
				return fmt.Errorf("failed to kill process %s (PID %d): %w", name, p.Pid, err)
			}
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("process %s not found", name)
	}

	return nil
}

// runCommand is a helper to run an OS command directly (no shell) with a 30-second timeout.
func runCommand(name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}
