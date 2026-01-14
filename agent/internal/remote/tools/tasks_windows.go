//go:build windows

package tools

import (
	"encoding/csv"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func listTasksOS(folder, search string, page, limit int, startTime time.Time) CommandResult {
	// Use schtasks to list tasks
	cmd := exec.Command("schtasks", "/query", "/fo", "csv", "/v")
	output, err := cmd.Output()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to list tasks: %w", err), time.Since(startTime).Milliseconds())
	}

	tasks := parseTaskList(string(output), folder, search)

	// Paginate
	total := len(tasks)
	totalPages := (total + limit - 1) / limit
	start := (page - 1) * limit
	end := start + limit

	if start > total {
		start = total
	}
	if end > total {
		end = total
	}

	response := TaskListResponse{
		Tasks:      tasks[start:end],
		Total:      total,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

func getTaskOS(path string, startTime time.Time) CommandResult {
	if path == "" {
		return NewErrorResult(fmt.Errorf("task path is required"), time.Since(startTime).Milliseconds())
	}

	cmd := exec.Command("schtasks", "/query", "/tn", path, "/fo", "csv", "/v")
	output, err := cmd.Output()
	if err != nil {
		return NewErrorResult(fmt.Errorf("task not found: %w", err), time.Since(startTime).Milliseconds())
	}

	tasks := parseTaskList(string(output), "", "")
	if len(tasks) == 0 {
		return NewErrorResult(fmt.Errorf("task not found"), time.Since(startTime).Milliseconds())
	}

	return NewSuccessResult(tasks[0], time.Since(startTime).Milliseconds())
}

func runTaskOS(path string, startTime time.Time) CommandResult {
	if path == "" {
		return NewErrorResult(fmt.Errorf("task path is required"), time.Since(startTime).Milliseconds())
	}

	cmd := exec.Command("schtasks", "/run", "/tn", path)
	if err := cmd.Run(); err != nil {
		return NewErrorResult(fmt.Errorf("failed to run task: %w", err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"path":    path,
		"action":  "run",
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func enableTaskOS(path string, startTime time.Time) CommandResult {
	if path == "" {
		return NewErrorResult(fmt.Errorf("task path is required"), time.Since(startTime).Milliseconds())
	}

	cmd := exec.Command("schtasks", "/change", "/tn", path, "/enable")
	if err := cmd.Run(); err != nil {
		return NewErrorResult(fmt.Errorf("failed to enable task: %w", err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"path":    path,
		"action":  "enable",
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func disableTaskOS(path string, startTime time.Time) CommandResult {
	if path == "" {
		return NewErrorResult(fmt.Errorf("task path is required"), time.Since(startTime).Milliseconds())
	}

	cmd := exec.Command("schtasks", "/change", "/tn", path, "/disable")
	if err := cmd.Run(); err != nil {
		return NewErrorResult(fmt.Errorf("failed to disable task: %w", err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"path":    path,
		"action":  "disable",
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func parseTaskList(output, folder, search string) []ScheduledTask {
	var tasks []ScheduledTask

	reader := csv.NewReader(strings.NewReader(output))
	records, err := reader.ReadAll()
	if err != nil {
		return tasks
	}

	if len(records) < 2 {
		return tasks
	}

	// Find column indices from header
	header := records[0]
	indices := make(map[string]int)
	for i, col := range header {
		indices[strings.TrimSpace(col)] = i
	}

	searchLower := strings.ToLower(search)
	folderLower := strings.ToLower(folder)

	for i := 1; i < len(records); i++ {
		row := records[i]
		if len(row) < len(header) {
			continue
		}

		taskPath := getField(row, indices, "TaskName")
		if taskPath == "" {
			continue
		}

		// Extract folder and name from path
		taskFolder := "\\"
		taskName := taskPath
		if lastSlash := strings.LastIndex(taskPath, "\\"); lastSlash > 0 {
			taskFolder = taskPath[:lastSlash]
			taskName = taskPath[lastSlash+1:]
		}

		// Apply folder filter
		if folder != "" && folder != "\\" {
			if !strings.HasPrefix(strings.ToLower(taskFolder), folderLower) {
				continue
			}
		}

		// Apply search filter
		if search != "" && !strings.Contains(strings.ToLower(taskName), searchLower) {
			continue
		}

		status := getField(row, indices, "Status")
		lastRun := getField(row, indices, "Last Run Time")
		nextRun := getField(row, indices, "Next Run Time")
		author := getField(row, indices, "Author")

		task := ScheduledTask{
			Name:        taskName,
			Path:        taskPath,
			Folder:      taskFolder,
			Status:      normalizeTaskStatus(status),
			LastRun:     lastRun,
			NextRun:     nextRun,
			Author:      author,
			Description: getField(row, indices, "Comment"),
		}

		// Parse triggers (simplified)
		triggers := getField(row, indices, "Scheduled Task State")
		if triggers != "" {
			task.Triggers = []string{triggers}
		}

		tasks = append(tasks, task)
	}

	return tasks
}

func getField(row []string, indices map[string]int, field string) string {
	if idx, ok := indices[field]; ok && idx < len(row) {
		return strings.TrimSpace(row[idx])
	}
	return ""
}

func normalizeTaskStatus(status string) string {
	switch strings.ToLower(status) {
	case "ready":
		return "ready"
	case "running":
		return "running"
	case "disabled":
		return "disabled"
	case "queued":
		return "queued"
	default:
		return status
	}
}
