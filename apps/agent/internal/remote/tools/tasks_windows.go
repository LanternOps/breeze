//go:build windows

package tools

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// schtasksDateFormats are the possible date/time formats returned by schtasks.exe
var schtasksDateFormats = []string{
	"1/2/2006 3:04:05 PM",
	"01/02/2006 3:04:05 PM",
	"1/2/2006 15:04:05",
	"01/02/2006 15:04:05",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"N/A",
}

// parseTaskTime attempts to parse a time string from schtasks output.
func parseTaskTime(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" || s == "N/A" {
		return time.Time{}
	}

	for _, format := range schtasksDateFormats {
		if format == "N/A" {
			continue
		}
		if t, err := time.ParseInLocation(format, s, time.Local); err == nil {
			return t
		}
	}
	return time.Time{}
}

// runSchtasks executes schtasks.exe with the given arguments.
func runSchtasks(args ...string) (string, error) {
	cmd := exec.Command("schtasks.exe", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = err.Error()
		}
		return "", fmt.Errorf("schtasks failed: %s", errMsg)
	}

	return stdout.String(), nil
}

// ListTasks lists all scheduled tasks in the specified folder.
// Use "\" for the root folder.
func (m *TaskSchedulerManager) ListTasks(folder string) ([]ScheduledTask, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Normalize folder path
	if folder == "" {
		folder = "\\"
	}

	// Query tasks in CSV format for easier parsing
	output, err := runSchtasks("/Query", "/FO", "CSV", "/V", "/TN", folder)
	if err != nil {
		// If folder doesn't exist or is empty, return empty list
		if strings.Contains(err.Error(), "does not exist") ||
			strings.Contains(err.Error(), "no scheduled task") {
			return []ScheduledTask{}, nil
		}
		return nil, err
	}

	return parseTaskListCSV(output)
}

// parseTaskListCSV parses the CSV output from schtasks /Query /FO CSV /V.
func parseTaskListCSV(output string) ([]ScheduledTask, error) {
	reader := csv.NewReader(strings.NewReader(output))
	records, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("failed to parse CSV output: %w", err)
	}

	if len(records) < 2 {
		return []ScheduledTask{}, nil
	}

	// Find column indices from header
	header := records[0]
	colIndex := make(map[string]int)
	for i, col := range header {
		colIndex[strings.ToLower(strings.TrimSpace(col))] = i
	}

	// Required columns
	taskNameIdx, ok := colIndex["taskname"]
	if !ok {
		return nil, fmt.Errorf("taskname column not found in output")
	}

	var tasks []ScheduledTask
	for _, record := range records[1:] {
		if len(record) <= taskNameIdx {
			continue
		}

		task := ScheduledTask{
			Path: record[taskNameIdx],
			Name: extractTaskName(record[taskNameIdx]),
		}

		// Parse optional columns
		if idx, ok := colIndex["status"]; ok && idx < len(record) {
			task.State = record[idx]
			task.Enabled = !strings.EqualFold(record[idx], "Disabled")
		}

		if idx, ok := colIndex["last run time"]; ok && idx < len(record) {
			task.LastRunTime = parseTaskTime(record[idx])
		}

		if idx, ok := colIndex["next run time"]; ok && idx < len(record) {
			task.NextRunTime = parseTaskTime(record[idx])
		}

		if idx, ok := colIndex["last result"]; ok && idx < len(record) {
			if result, err := strconv.Atoi(record[idx]); err == nil {
				task.LastTaskResult = result
			}
		}

		if idx, ok := colIndex["author"]; ok && idx < len(record) {
			task.Author = record[idx]
		}

		if idx, ok := colIndex["comment"]; ok && idx < len(record) {
			task.Description = record[idx]
		}

		tasks = append(tasks, task)
	}

	return tasks, nil
}

// extractTaskName extracts the task name from the full path.
func extractTaskName(path string) string {
	parts := strings.Split(path, "\\")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return path
}

// GetTask retrieves detailed information about a specific task.
func (m *TaskSchedulerManager) GetTask(path string) (*TaskDetails, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	output, err := runSchtasks("/Query", "/FO", "CSV", "/V", "/TN", path)
	if err != nil {
		return nil, fmt.Errorf("failed to get task %s: %w", path, err)
	}

	tasks, err := parseTaskListCSV(output)
	if err != nil {
		return nil, err
	}

	if len(tasks) == 0 {
		return nil, fmt.Errorf("task not found: %s", path)
	}

	task := tasks[0]
	details := &TaskDetails{
		ScheduledTask: task,
		Triggers:      []TaskTrigger{},
		Actions:       []TaskAction{},
	}

	// Get additional details from XML export
	xmlOutput, err := runSchtasks("/Query", "/XML", "/TN", path)
	if err == nil {
		parseTaskXML(xmlOutput, details)
	}

	return details, nil
}

// parseTaskXML extracts additional details from the task XML definition.
func parseTaskXML(xmlData string, details *TaskDetails) {
	// Parse Principal/RunLevel
	if strings.Contains(xmlData, "<RunLevel>HighestAvailable</RunLevel>") {
		details.RunLevel = "HighestAvailable"
	} else {
		details.RunLevel = "LeastPrivilege"
	}

	// Extract principal/user
	if start := strings.Index(xmlData, "<UserId>"); start != -1 {
		end := strings.Index(xmlData[start:], "</UserId>")
		if end != -1 {
			details.Principal = xmlData[start+8 : start+end]
		}
	}

	// Parse triggers (simplified extraction)
	details.Triggers = extractTriggers(xmlData)

	// Parse actions
	details.Actions = extractActions(xmlData)
}

// extractTriggers extracts trigger information from task XML.
func extractTriggers(xmlData string) []TaskTrigger {
	var triggers []TaskTrigger

	triggerTypes := map[string]string{
		"<CalendarTrigger>":       "Calendar",
		"<TimeTrigger>":           "Time",
		"<DailyTrigger>":          "Daily",
		"<WeeklyTrigger>":         "Weekly",
		"<MonthlyTrigger>":        "Monthly",
		"<BootTrigger>":           "OnBoot",
		"<LogonTrigger>":          "OnLogon",
		"<IdleTrigger>":           "OnIdle",
		"<EventTrigger>":          "OnEvent",
		"<RegistrationTrigger>":   "OnRegistration",
		"<SessionStateChangeTrigger>": "OnSessionChange",
	}

	for tag, triggerType := range triggerTypes {
		if strings.Contains(xmlData, tag) {
			trigger := TaskTrigger{
				Type:    triggerType,
				Enabled: true,
			}

			// Check if trigger is disabled
			closeTag := strings.Replace(tag, "<", "</", 1)
			start := strings.Index(xmlData, tag)
			if start != -1 {
				end := strings.Index(xmlData[start:], closeTag)
				if end != -1 {
					triggerXML := xmlData[start : start+end]
					if strings.Contains(triggerXML, "<Enabled>false</Enabled>") {
						trigger.Enabled = false
					}

					// Extract start boundary
					if boundStart := strings.Index(triggerXML, "<StartBoundary>"); boundStart != -1 {
						boundEnd := strings.Index(triggerXML[boundStart:], "</StartBoundary>")
						if boundEnd != -1 {
							timeStr := triggerXML[boundStart+15 : boundStart+boundEnd]
							if t, err := time.Parse(time.RFC3339, timeStr); err == nil {
								trigger.StartTime = t
							}
						}
					}
				}
			}

			triggers = append(triggers, trigger)
		}
	}

	return triggers
}

// extractActions extracts action information from task XML.
func extractActions(xmlData string) []TaskAction {
	var actions []TaskAction

	// Find all Exec actions
	remaining := xmlData
	for {
		start := strings.Index(remaining, "<Exec>")
		if start == -1 {
			break
		}
		end := strings.Index(remaining[start:], "</Exec>")
		if end == -1 {
			break
		}

		execXML := remaining[start : start+end+7]
		remaining = remaining[start+end+7:]

		action := TaskAction{
			Type: "Execute",
		}

		// Extract command
		if cmdStart := strings.Index(execXML, "<Command>"); cmdStart != -1 {
			cmdEnd := strings.Index(execXML[cmdStart:], "</Command>")
			if cmdEnd != -1 {
				action.Path = execXML[cmdStart+9 : cmdStart+cmdEnd]
			}
		}

		// Extract arguments
		if argStart := strings.Index(execXML, "<Arguments>"); argStart != -1 {
			argEnd := strings.Index(execXML[argStart:], "</Arguments>")
			if argEnd != -1 {
				action.Arguments = execXML[argStart+11 : argStart+argEnd]
			}
		}

		// Extract working directory
		if wdStart := strings.Index(execXML, "<WorkingDirectory>"); wdStart != -1 {
			wdEnd := strings.Index(execXML[wdStart:], "</WorkingDirectory>")
			if wdEnd != -1 {
				action.WorkingDir = execXML[wdStart+18 : wdStart+wdEnd]
			}
		}

		actions = append(actions, action)
	}

	return actions
}

// RunTask runs a scheduled task immediately.
func (m *TaskSchedulerManager) RunTask(path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, err := runSchtasks("/Run", "/TN", path)
	if err != nil {
		return fmt.Errorf("failed to run task %s: %w", path, err)
	}

	return nil
}

// EnableTask enables a disabled scheduled task.
func (m *TaskSchedulerManager) EnableTask(path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, err := runSchtasks("/Change", "/TN", path, "/Enable")
	if err != nil {
		return fmt.Errorf("failed to enable task %s: %w", path, err)
	}

	return nil
}

// DisableTask disables a scheduled task.
func (m *TaskSchedulerManager) DisableTask(path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, err := runSchtasks("/Change", "/TN", path, "/Disable")
	if err != nil {
		return fmt.Errorf("failed to disable task %s: %w", path, err)
	}

	return nil
}

// GetTaskHistory retrieves the execution history for a task.
// This uses Windows Event Log to get task scheduler history.
func (m *TaskSchedulerManager) GetTaskHistory(path string, limit int) ([]TaskHistory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if limit <= 0 {
		limit = 50
	}

	// Use wevtutil to query Task Scheduler operational log
	// Filter by task name
	taskName := extractTaskName(path)
	query := fmt.Sprintf(
		"*[EventData[Data[@Name='TaskName']='%s']]",
		path,
	)

	cmd := exec.Command("wevtutil.exe", "qe",
		"Microsoft-Windows-TaskScheduler/Operational",
		"/q:"+query,
		"/c:"+strconv.Itoa(limit),
		"/rd:true", // Reverse direction (newest first)
		"/f:text",
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// If there's no history or log is disabled, return empty
		if strings.Contains(stderr.String(), "No events") ||
			strings.Contains(stderr.String(), "not found") {
			return []TaskHistory{}, nil
		}
		return nil, fmt.Errorf("failed to get task history for %s: %w", taskName, err)
	}

	return parseEventLogOutput(stdout.String())
}

// parseEventLogOutput parses the text output from wevtutil.
func parseEventLogOutput(output string) ([]TaskHistory, error) {
	var history []TaskHistory
	var current *TaskHistory

	lines := strings.Split(output, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "Event[") {
			// Start of new event
			if current != nil {
				history = append(history, *current)
			}
			current = &TaskHistory{}

			// Extract record ID from Event[N]
			if start := strings.Index(line, "["); start != -1 {
				if end := strings.Index(line[start:], "]"); end != -1 {
					if id, err := strconv.ParseUint(line[start+1:start+end], 10, 64); err == nil {
						current.RecordID = id
					}
				}
			}
		} else if current != nil {
			// Parse field
			if parts := strings.SplitN(line, ":", 2); len(parts) == 2 {
				key := strings.TrimSpace(parts[0])
				value := strings.TrimSpace(parts[1])

				switch key {
				case "Event ID":
					if id, err := strconv.ParseUint(value, 10, 32); err == nil {
						current.EventID = uint32(id)
					}
				case "Level":
					current.Level = value
				case "Date":
					// Try to parse the date
					if t, err := time.Parse("2006-01-02T15:04:05.000", value); err == nil {
						current.TimeStamp = t
					} else if t, err := time.Parse("2006-01-02T15:04:05", value); err == nil {
						current.TimeStamp = t
					}
				case "Description":
					current.Message = value
				}
			}
		}
	}

	// Don't forget the last event
	if current != nil {
		history = append(history, *current)
	}

	return history, nil
}

// IsSupported returns true if the Task Scheduler is supported on the current platform.
func (m *TaskSchedulerManager) IsSupported() bool {
	return true
}
