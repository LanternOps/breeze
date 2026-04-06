package tools

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

// ListProcesses returns a paginated list of running processes.
// On Windows, gopsutil's Username() calls LookupAccountSid per process which
// can be very slow with AzureAD/domain accounts. We use 2 workers to overlap
// IO-bound SID lookups without saturating CPU.
func ListProcesses(payload map[string]any) CommandResult {
	startTime := time.Now()

	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)
	search := GetPayloadString(payload, "search", "")
	sortBy := GetPayloadString(payload, "sortBy", "cpu")
	sortDesc := GetPayloadBool(payload, "sortDesc", true)
	search, _ = truncateStringBytes(search, maxProcessFieldBytes)

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

	// 8 workers: overlaps IO-bound SID lookups (the bottleneck on Windows with
	// AzureAD). The earlier 400% CPU spike was from leaked timeout goroutines
	// in getProcessInfo, not the worker count — those are removed now.
	const workers = 8

	type indexedInfo struct {
		idx  int
		info *ProcessInfo
	}

	results := make([]indexedInfo, 0, len(procs))
	var mu sync.Mutex

	jobs := make(chan struct {
		idx int
		p   *process.Process
	}, len(procs))
	var wg sync.WaitGroup

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				info := getProcessInfo(job.p)
				if info != nil {
					mu.Lock()
					results = append(results, indexedInfo{idx: job.idx, info: info})
					mu.Unlock()
				}
			}
		}()
	}

	for i, p := range procs {
		jobs <- struct {
			idx int
			p   *process.Process
		}{idx: i, p: p}
	}
	close(jobs)
	wg.Wait()

	// Restore original order for deterministic output.
	sort.Slice(results, func(i, j int) bool {
		return results[i].idx < results[j].idx
	})

	var processList []ProcessInfo
	searchLower := strings.ToLower(search)

	for _, r := range results {
		info := r.info

		if search != "" {
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
	processList, truncated := sanitizeProcessList(processList)

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
		Truncated:  truncated,
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

	info := getFullProcessInfo(p)
	if info == nil {
		return NewErrorResult(fmt.Errorf("failed to get process info"), time.Since(startTime).Milliseconds())
	}
	infoValue, _ := sanitizeProcessInfo(*info)

	return NewSuccessResult(infoValue, time.Since(startTime).Milliseconds())
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

// getProcessInfo collects lightweight fields for the list view.
// Expensive fields (CommandLine, CreateTime, Status, Threads, ParentPID)
// are fetched on demand via GetProcess when the user expands a row.
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

	info.User = resolveUsername(p)

	if cpuPercent, err := p.CPUPercent(); err == nil {
		info.CPUPercent = cpuPercent
	}

	if memInfo, err := p.MemoryInfo(); err == nil && memInfo != nil {
		info.MemoryMB = float64(memInfo.RSS) / 1024 / 1024
	}

	return info
}

// getFullProcessInfo collects all fields including expensive ones.
// Used by GetProcess for the single-process detail view.
func getFullProcessInfo(p *process.Process) *ProcessInfo {
	info := getProcessInfo(p)
	if info == nil {
		return nil
	}

	if cmdline, err := p.Cmdline(); err == nil {
		info.CommandLine = cmdline
	}

	if ppid, err := p.Ppid(); err == nil {
		info.ParentPID = ppid
	}

	if threads, err := p.NumThreads(); err == nil {
		info.Threads = threads
	}

	if createTime, err := p.CreateTime(); err == nil {
		info.CreateTime = createTime
	}

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
