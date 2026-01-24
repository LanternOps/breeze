//go:build linux

package tools

import (
	"bufio"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ListProcesses returns all running processes on Linux by reading /proc
func (pm *ProcessManager) ListProcesses() ([]Process, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, fmt.Errorf("failed to read /proc: %w", err)
	}

	var processes []Process
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			// Not a PID directory
			continue
		}

		proc, err := readProcessInfo(pid)
		if err != nil {
			// Skip processes we can't read (permission errors, etc.)
			continue
		}

		processes = append(processes, proc)
	}

	return processes, nil
}

// readProcessInfo reads process information from /proc/[pid]
func readProcessInfo(pid int) (Process, error) {
	procPath := filepath.Join("/proc", strconv.Itoa(pid))

	// Read /proc/[pid]/stat for process status and stats
	statPath := filepath.Join(procPath, "stat")
	statData, err := os.ReadFile(statPath)
	if err != nil {
		return Process{}, err
	}

	proc, err := parseStatFile(pid, string(statData))
	if err != nil {
		return Process{}, err
	}

	// Read /proc/[pid]/cmdline for command line
	cmdlinePath := filepath.Join(procPath, "cmdline")
	cmdlineData, err := os.ReadFile(cmdlinePath)
	if err == nil {
		// cmdline uses null bytes as separators
		cmdline := strings.ReplaceAll(string(cmdlineData), "\x00", " ")
		proc.CommandLine = strings.TrimSpace(cmdline)
	}

	// Read /proc/[pid]/status for additional info
	statusPath := filepath.Join(procPath, "status")
	if statusFile, err := os.Open(statusPath); err == nil {
		defer statusFile.Close()
		scanner := bufio.NewScanner(statusFile)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "Uid:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if uid, err := strconv.Atoi(fields[1]); err == nil {
						if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
							proc.User = u.Username
						} else {
							proc.User = fields[1]
						}
					}
				}
			}
			if strings.HasPrefix(line, "VmRSS:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if rssKB, err := strconv.ParseFloat(fields[1], 64); err == nil {
						proc.MemoryMB = rssKB / 1024.0
					}
				}
			}
		}
	}

	// Get CPU percentage from /proc/[pid]/stat
	proc.CPUPercent = calculateCPUPercent(pid)

	return proc, nil
}

// parseStatFile parses /proc/[pid]/stat
func parseStatFile(pid int, data string) (Process, error) {
	// The format is tricky because the command name can contain spaces and parentheses
	// Format: pid (comm) state ppid ...
	
	// Find the last ) to handle command names with parentheses
	lastParen := strings.LastIndex(data, ")")
	if lastParen == -1 {
		return Process{}, fmt.Errorf("invalid stat format")
	}

	// Extract comm (between first ( and last ))
	firstParen := strings.Index(data, "(")
	if firstParen == -1 {
		return Process{}, fmt.Errorf("invalid stat format")
	}
	
	comm := data[firstParen+1 : lastParen]
	
	// Parse remaining fields after the closing parenthesis
	remaining := strings.Fields(data[lastParen+2:])
	if len(remaining) < 2 {
		return Process{}, fmt.Errorf("insufficient fields in stat")
	}

	state := remaining[0]
	ppid, _ := strconv.Atoi(remaining[1])

	// Get start time (field 21 in stat, index 19 in remaining)
	startTime := ""
	if len(remaining) > 19 {
		if startTicks, err := strconv.ParseInt(remaining[19], 10, 64); err == nil {
			startTime = formatStartTime(startTicks)
		}
	}

	return Process{
		PID:       pid,
		Name:      comm,
		Status:    mapLinuxStatus(state),
		ParentPID: ppid,
		StartTime: startTime,
	}, nil
}

// mapLinuxStatus converts Linux process state codes to human-readable status
func mapLinuxStatus(state string) string {
	if len(state) == 0 {
		return "unknown"
	}

	switch state[0] {
	case 'R':
		return "running"
	case 'S':
		return "sleeping"
	case 'D':
		return "uninterruptible"
	case 'T', 't':
		return "stopped"
	case 'Z':
		return "zombie"
	case 'X', 'x':
		return "dead"
	case 'I':
		return "idle"
	default:
		return "unknown"
	}
}

// formatStartTime converts process start time from clock ticks to a readable format
func formatStartTime(startTicks int64) string {
	// Get system boot time
	uptimeData, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return ""
	}
	
	uptimeParts := strings.Fields(string(uptimeData))
	if len(uptimeParts) == 0 {
		return ""
	}
	
	uptimeSeconds, err := strconv.ParseFloat(uptimeParts[0], 64)
	if err != nil {
		return ""
	}

	// Clock ticks per second (usually 100)
	clkTck := int64(100) // sysconf(_SC_CLK_TCK)
	
	// Calculate process start time
	processStartSeconds := float64(startTicks) / float64(clkTck)
	bootTime := time.Now().Add(-time.Duration(uptimeSeconds * float64(time.Second)))
	processStart := bootTime.Add(time.Duration(processStartSeconds * float64(time.Second)))

	return processStart.Format(time.RFC3339)
}

// calculateCPUPercent calculates the CPU usage percentage for a process
func calculateCPUPercent(pid int) float64 {
	statPath := filepath.Join("/proc", strconv.Itoa(pid), "stat")
	
	// Read process stats twice with a small delay
	stats1, err := readProcessCPUStats(statPath)
	if err != nil {
		return 0
	}
	
	totalCPU1, err := readTotalCPU()
	if err != nil {
		return 0
	}

	time.Sleep(100 * time.Millisecond)

	stats2, err := readProcessCPUStats(statPath)
	if err != nil {
		return 0
	}
	
	totalCPU2, err := readTotalCPU()
	if err != nil {
		return 0
	}

	// Calculate CPU percentage
	processDelta := (stats2.utime + stats2.stime) - (stats1.utime + stats1.stime)
	totalDelta := totalCPU2 - totalCPU1

	if totalDelta == 0 {
		return 0
	}

	return float64(processDelta) / float64(totalDelta) * 100.0
}

type cpuStats struct {
	utime int64
	stime int64
}

func readProcessCPUStats(statPath string) (cpuStats, error) {
	data, err := os.ReadFile(statPath)
	if err != nil {
		return cpuStats{}, err
	}

	// Find the last ) to skip the command name
	lastParen := strings.LastIndex(string(data), ")")
	if lastParen == -1 {
		return cpuStats{}, fmt.Errorf("invalid stat format")
	}

	fields := strings.Fields(string(data)[lastParen+2:])
	if len(fields) < 14 {
		return cpuStats{}, fmt.Errorf("insufficient fields")
	}

	// utime is field 14 (index 11 after removing pid and comm)
	// stime is field 15 (index 12)
	utime, _ := strconv.ParseInt(fields[11], 10, 64)
	stime, _ := strconv.ParseInt(fields[12], 10, 64)

	return cpuStats{utime: utime, stime: stime}, nil
}

func readTotalCPU() (int64, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, err
	}

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)
			var total int64
			for i := 1; i < len(fields); i++ {
				val, _ := strconv.ParseInt(fields[i], 10, 64)
				total += val
			}
			return total, nil
		}
	}

	return 0, fmt.Errorf("cpu stats not found")
}

// KillProcess terminates a process by PID on Linux
func (pm *ProcessManager) KillProcess(pid int) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if pid <= 0 {
		return fmt.Errorf("%w: invalid pid %d", ErrProcessNotFound, pid)
	}

	// First try SIGTERM for graceful shutdown
	err := syscall.Kill(pid, syscall.SIGTERM)
	if err != nil {
		if err == syscall.ESRCH {
			return ErrProcessNotFound
		}
		if err == syscall.EPERM {
			return ErrAccessDenied
		}
		return fmt.Errorf("%w: %v", ErrKillFailed, err)
	}

	// Give the process time to terminate gracefully
	time.Sleep(100 * time.Millisecond)

	// Check if process still exists
	err = syscall.Kill(pid, 0)
	if err == syscall.ESRCH {
		// Process terminated successfully
		return nil
	}

	// Process still running, send SIGKILL
	err = syscall.Kill(pid, syscall.SIGKILL)
	if err != nil {
		if err == syscall.ESRCH {
			return nil // Process already terminated
		}
		if err == syscall.EPERM {
			return ErrAccessDenied
		}
		return fmt.Errorf("%w: %v", ErrKillFailed, err)
	}

	return nil
}

// GetProcessDetails returns detailed information for a single process on Linux
func (pm *ProcessManager) GetProcessDetails(pid int) (*Process, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if pid <= 0 {
		return nil, fmt.Errorf("%w: invalid pid %d", ErrProcessNotFound, pid)
	}

	procPath := filepath.Join("/proc", strconv.Itoa(pid))
	
	// Check if process exists
	if _, err := os.Stat(procPath); os.IsNotExist(err) {
		return nil, ErrProcessNotFound
	}

	proc, err := readProcessInfo(pid)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrProcessNotFound
		}
		if os.IsPermission(err) {
			return nil, ErrAccessDenied
		}
		return nil, fmt.Errorf("failed to get process details: %w", err)
	}

	return &proc, nil
}
