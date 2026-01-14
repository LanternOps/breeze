package tools

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

// ListProcesses returns a paginated list of running processes
func ListProcesses(payload map[string]any) CommandResult {
	startTime := time.Now()

	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)
	search := GetPayloadString(payload, "search", "")
	sortBy := GetPayloadString(payload, "sortBy", "cpu")
	sortDesc := GetPayloadBool(payload, "sortDesc", true)

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 500 {
		limit = 50
	}

	procs, err := process.Processes()
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	var processList []ProcessInfo
	for _, p := range procs {
		info := getProcessInfo(p)
		if info == nil {
			continue
		}

		// Apply search filter
		if search != "" {
			searchLower := strings.ToLower(search)
			nameLower := strings.ToLower(info.Name)
			userLower := strings.ToLower(info.User)
			cmdLower := strings.ToLower(info.CommandLine)
			pidStr := fmt.Sprintf("%d", info.PID)

			if !strings.Contains(nameLower, searchLower) &&
				!strings.Contains(userLower, searchLower) &&
				!strings.Contains(cmdLower, searchLower) &&
				!strings.Contains(pidStr, searchLower) {
				continue
			}
		}

		processList = append(processList, *info)
	}

	// Sort processes
	sortProcesses(processList, sortBy, sortDesc)

	// Paginate
	total := len(processList)
	totalPages := (total + limit - 1) / limit
	start := (page - 1) * limit
	end := start + limit

	if start > total {
		start = total
	}
	if end > total {
		end = total
	}

	response := ProcessListResponse{
		Processes:  processList[start:end],
		Total:      total,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

// GetProcess returns details for a specific process
func GetProcess(payload map[string]any) CommandResult {
	startTime := time.Now()

	pid := GetPayloadInt(payload, "pid", 0)
	if pid == 0 {
		return NewErrorResult(fmt.Errorf("pid is required"), time.Since(startTime).Milliseconds())
	}

	p, err := process.NewProcess(int32(pid))
	if err != nil {
		return NewErrorResult(fmt.Errorf("process not found: %w", err), time.Since(startTime).Milliseconds())
	}

	info := getProcessInfo(p)
	if info == nil {
		return NewErrorResult(fmt.Errorf("failed to get process info"), time.Since(startTime).Milliseconds())
	}

	return NewSuccessResult(info, time.Since(startTime).Milliseconds())
}

// KillProcess terminates a process by PID
func KillProcess(payload map[string]any) CommandResult {
	startTime := time.Now()

	pid := GetPayloadInt(payload, "pid", 0)
	if pid == 0 {
		return NewErrorResult(fmt.Errorf("pid is required"), time.Since(startTime).Milliseconds())
	}

	force := GetPayloadBool(payload, "force", false)

	p, err := process.NewProcess(int32(pid))
	if err != nil {
		return NewErrorResult(fmt.Errorf("process not found: %w", err), time.Since(startTime).Milliseconds())
	}

	// Get process name for logging
	name, _ := p.Name()

	if force {
		err = p.Kill()
	} else {
		err = p.Terminate()
	}

	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to terminate process %d (%s): %w", pid, name, err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"pid":        pid,
		"name":       name,
		"terminated": true,
		"force":      force,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func getProcessInfo(p *process.Process) *ProcessInfo {
	name, err := p.Name()
	if err != nil {
		return nil
	}

	info := &ProcessInfo{
		PID:    p.Pid,
		Name:   name,
		Status: "running",
	}

	// Get username (may fail for system processes)
	if username, err := p.Username(); err == nil {
		info.User = username
	}

	// Get CPU percent (averaged over a short interval)
	if cpuPercent, err := p.CPUPercent(); err == nil {
		info.CPUPercent = cpuPercent
	}

	// Get memory info
	if memInfo, err := p.MemoryInfo(); err == nil && memInfo != nil {
		info.MemoryMB = float64(memInfo.RSS) / 1024 / 1024
	}

	// Get command line
	if cmdline, err := p.Cmdline(); err == nil {
		info.CommandLine = cmdline
	}

	// Get parent PID
	if ppid, err := p.Ppid(); err == nil {
		info.ParentPID = ppid
	}

	// Get thread count
	if threads, err := p.NumThreads(); err == nil {
		info.Threads = threads
	}

	// Get create time
	if createTime, err := p.CreateTime(); err == nil {
		info.CreateTime = createTime
	}

	// Get status
	if status, err := p.Status(); err == nil && len(status) > 0 {
		info.Status = status[0]
	}

	return info
}

func sortProcesses(processes []ProcessInfo, sortBy string, desc bool) {
	sort.Slice(processes, func(i, j int) bool {
		var less bool
		switch sortBy {
		case "pid":
			less = processes[i].PID < processes[j].PID
		case "name":
			less = strings.ToLower(processes[i].Name) < strings.ToLower(processes[j].Name)
		case "user":
			less = strings.ToLower(processes[i].User) < strings.ToLower(processes[j].User)
		case "memory":
			less = processes[i].MemoryMB < processes[j].MemoryMB
		case "cpu":
			fallthrough
		default:
			less = processes[i].CPUPercent < processes[j].CPUPercent
		}

		if desc {
			return !less
		}
		return less
	})
}
