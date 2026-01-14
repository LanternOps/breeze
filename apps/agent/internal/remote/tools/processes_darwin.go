//go:build darwin

package tools

import (
	"bufio"
	"bytes"
	"fmt"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ListProcesses returns all running processes on macOS
func (pm *ProcessManager) ListProcesses() ([]Process, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	// Use ps command to get process information
	// Format: pid,ppid,stat,user,%cpu,rss,lstart,command
	// Using 'command' instead of 'comm' to get full path, then extract base name
	cmd := exec.Command("ps", "-axo", "pid=,ppid=,stat=,user=,%cpu=,rss=,lstart=,command=")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to execute ps command: %w", err)
	}

	return parseProcessOutput(output)
}

// parseProcessOutput parses the ps command output into Process structs
func parseProcessOutput(output []byte) ([]Process, error) {
	var processes []Process
	scanner := bufio.NewScanner(bytes.NewReader(output))

	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		proc, err := parseProcessLine(line)
		if err != nil {
			// Skip processes we can't parse (permission errors, etc.)
			continue
		}
		processes = append(processes, proc)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading ps output: %w", err)
	}

	return processes, nil
}

// parseProcessLine parses a single line of ps output
func parseProcessLine(line string) (Process, error) {
	// Line format: PID PPID STAT USER %CPU RSS LSTART COMMAND
	// LSTART spans 5 fields: Day Mon DD HH:MM:SS YYYY
	// Everything after LSTART is the command
	
	line = strings.TrimSpace(line)
	fields := strings.Fields(line)
	if len(fields) < 12 {
		return Process{}, fmt.Errorf("insufficient fields in line")
	}

	pid, err := strconv.Atoi(fields[0])
	if err != nil {
		return Process{}, fmt.Errorf("invalid pid: %w", err)
	}

	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		ppid = 0 // Default to 0 if can't parse
	}

	stat := fields[2]
	userName := fields[3]

	cpuPercent, err := strconv.ParseFloat(fields[4], 64)
	if err != nil {
		cpuPercent = 0
	}

	// RSS is in KB, convert to MB
	rssKB, err := strconv.ParseFloat(fields[5], 64)
	if err != nil {
		rssKB = 0
	}
	memoryMB := rssKB / 1024.0

	// lstart spans fields 6-10 (e.g., "Mon Jan 13 10:30:00 2025")
	startTime := strings.Join(fields[6:11], " ")

	// Command is everything from field 11 onwards
	commandLine := strings.Join(fields[11:], " ")
	
	// Extract just the process name from the command
	name := extractProcessName(commandLine)

	status := mapDarwinStatus(stat)

	return Process{
		PID:         pid,
		Name:        name,
		Status:      status,
		CPUPercent:  cpuPercent,
		MemoryMB:    memoryMB,
		User:        userName,
		CommandLine: commandLine,
		ParentPID:   ppid,
		StartTime:   startTime,
	}, nil
}

// extractProcessName extracts the process name from a command line
func extractProcessName(commandLine string) string {
	if commandLine == "" {
		return ""
	}
	
	// Get the first part (the executable path/name)
	parts := strings.Fields(commandLine)
	if len(parts) == 0 {
		return ""
	}
	
	execPath := parts[0]
	
	// Get just the base name
	name := filepath.Base(execPath)
	
	// Remove any path that looks like it starts with - (flags)
	if strings.HasPrefix(name, "-") {
		return execPath
	}
	
	return name
}

// mapDarwinStatus converts macOS process state codes to human-readable status
func mapDarwinStatus(stat string) string {
	if len(stat) == 0 {
		return "unknown"
	}

	switch stat[0] {
	case 'R':
		return "running"
	case 'S':
		return "sleeping"
	case 'I':
		return "idle"
	case 'T':
		return "stopped"
	case 'U':
		return "uninterruptible"
	case 'Z':
		return "zombie"
	default:
		return "unknown"
	}
}

// KillProcess terminates a process by PID on macOS
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

// GetProcessDetails returns detailed information for a single process on macOS
func (pm *ProcessManager) GetProcessDetails(pid int) (*Process, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if pid <= 0 {
		return nil, fmt.Errorf("%w: invalid pid %d", ErrProcessNotFound, pid)
	}

	// Use ps to get information for specific process
	cmd := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "pid=,ppid=,stat=,user=,%cpu=,rss=,lstart=,command=")
	output, err := cmd.Output()
	if err != nil {
		// Check if process doesn't exist
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, ErrProcessNotFound
		}
		return nil, fmt.Errorf("failed to get process details: %w", err)
	}

	processes, err := parseProcessOutput(output)
	if err != nil {
		return nil, err
	}

	if len(processes) == 0 {
		return nil, ErrProcessNotFound
	}

	proc := processes[0]

	// Try to get additional details
	proc = enrichProcessDetails(proc)

	return &proc, nil
}

// enrichProcessDetails adds additional information to a process
func enrichProcessDetails(proc Process) Process {
	// Try to resolve username from UID if needed
	if proc.User != "" {
		if u, err := user.Lookup(proc.User); err == nil {
			proc.User = u.Username
		}
	}

	return proc
}
