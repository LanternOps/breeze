//go:build windows

package tools

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// listTasksPS outputs one task per line. Each line has fields separated by
// the unit separator character (0x1F). String fields that might contain
// special characters (name, author, description) are base64-encoded.
// This completely avoids PowerShell JSON serialization bugs (PS 5.1
// fails to escape double quotes in certain CIM string properties).
//
// Fields per line (0x1F-separated):
//   0: name (base64)
//   1: full path = TaskPath+TaskName (base64)
//   2: folder (base64)
//   3: status (lowercase: ready/running/disabled/queued)
//   4: author (base64)
//   5: description (base64)
//   6: lastRun (ISO 8601 or empty)
//   7: nextRun (ISO 8601 or empty)
//   8: lastResult (int or empty)
//   9: triggers (pipe-separated base64 strings, may be empty)
const listTasksPS = `$ErrorActionPreference='SilentlyContinue'
$U=[char]31
function B($s){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s))}
$tasks=@(Get-ScheduledTask)
$im=@{}
$tasks|Get-ScheduledTaskInfo|ForEach-Object{$im[$_.TaskPath+$_.TaskName]=$_}
foreach($t in $tasks){
  $i=$im[$t.TaskPath+$t.TaskName]
  $lr='';$nr='';$res=''
  if($i){
    if($i.LastRunTime.Year -gt 1601){$lr=$i.LastRunTime.ToString('o')}
    if($i.NextRunTime.Year -gt 1601){$nr=$i.NextRunTime.ToString('o')}
    $res=[string][int]$i.LastTaskResult
  }
  $f=$t.TaskPath.TrimEnd('\')
  if(-not $f){$f='\'}
  $trigs=@($t.Triggers|ForEach-Object{
    $c=$_.CimClass.CimClassName-replace'MSFT_Task','' -replace'Trigger',''
    switch($c){
      'Registration'{'At task creation'}
      'Boot'{'At startup'}
      'Logon'{'At log on'}
      'Idle'{'On idle'}
      'Time'{'One time'}
      'Daily'{'Daily'}
      'Weekly'{'Weekly'}
      'Monthly'{'Monthly'}
      'Event'{'On event'}
      'SessionStateChange'{'On session change'}
      default{$c}
    }
  })
  $trigB64=($trigs|ForEach-Object{B $_})-join'|'
  Write-Output ((B $t.TaskName)+$U+(B($t.TaskPath+$t.TaskName))+$U+(B $f)+$U+$t.State.ToString().ToLower()+$U+(B $t.Author)+$U+(B $t.Description)+$U+$lr+$U+$nr+$U+$res+$U+$trigB64)
}`

func decB64(s string) string {
	if s == "" {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		slog.Warn("base64 decode failed, using raw value",
			"raw", s, "error", err.Error())
		return s
	}
	return string(b)
}

func parseTSVTasks(output string) []ScheduledTask {
	var tasks []ScheduledTask
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\x1f")
		if len(fields) < 9 {
			continue
		}

		var lastResult int
		if fields[8] != "" {
			lastResult, _ = strconv.Atoi(fields[8])
		}

		var triggers []string
		if len(fields) > 9 && fields[9] != "" {
			for _, tb := range strings.Split(fields[9], "|") {
				if t := decB64(tb); t != "" {
					triggers = append(triggers, t)
				}
			}
		}

		tasks = append(tasks, ScheduledTask{
			Name:        decB64(fields[0]),
			Path:        decB64(fields[1]),
			Folder:      decB64(fields[2]),
			Status:      fields[3],
			Author:      decB64(fields[4]),
			Description: decB64(fields[5]),
			LastRun:     fields[6],
			NextRun:     fields[7],
			LastResult:  lastResult,
			Triggers:    triggers,
		})
	}
	return tasks
}

func listTasksOS(folder, search string, page, limit int, startTime time.Time) CommandResult {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", listTasksPS)
	output, err := cmd.Output()
	if err != nil {
		errMsg := fmt.Sprintf("failed to list tasks: %v", err)
		if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
			errMsg = fmt.Sprintf("failed to list tasks: %s", strings.TrimSpace(string(exitErr.Stderr)))
		}
		return NewErrorResult(fmt.Errorf("%s", errMsg), time.Since(startTime).Milliseconds())
	}

	allTasks := parseTSVTasks(string(output))
	if len(allTasks) == 0 {
		slog.Warn("scheduled tasks query returned zero results; possible permissions issue or PowerShell error")
	}

	// Apply folder and search filters.
	searchLower := strings.ToLower(search)
	folderLower := strings.ToLower(folder)
	var filtered []ScheduledTask

	for _, task := range allTasks {
		if folder != "" && folder != "\\" {
			if !strings.HasPrefix(strings.ToLower(task.Folder), folderLower) {
				continue
			}
		}
		if search != "" {
			if !strings.Contains(strings.ToLower(task.Name), searchLower) &&
				!strings.Contains(strings.ToLower(task.Path), searchLower) &&
				!strings.Contains(strings.ToLower(task.Description), searchLower) {
				continue
			}
		}
		filtered = append(filtered, task)
	}

	// Paginate
	total := len(filtered)
	totalPages := (total + limit - 1) / limit
	start := (page - 1) * limit
	end := start + limit

	if start > total {
		start = total
	}
	if end > total {
		end = total
	}

	resultTasks := filtered[start:end]
	if resultTasks == nil {
		resultTasks = []ScheduledTask{}
	}

	response := TaskListResponse{
		Tasks:      resultTasks,
		Total:      total,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

// getTaskOS retrieves a single scheduled task's detail. The inline
// PowerShell script uses the same base64/US format as listTasksPS
// for the first line, plus additional TRIG and ACT lines.
//
// Line 1: same 10 fields as listTasksPS output
// Line 2+: "TRIG" US type US enabled US startBoundary (base64, ISO 8601 datetime)
// Line N+: "ACT" US type US path(b64) US args(b64)
func getTaskOS(path string, startTime time.Time) CommandResult {
	if path == "" {
		return NewErrorResult(fmt.Errorf("task path is required"), time.Since(startTime).Milliseconds())
	}

	escapedPath := strings.ReplaceAll(path, "'", "''")
	script := fmt.Sprintf(`$ErrorActionPreference='SilentlyContinue'
$U=[char]31
function B($s){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s))}
$fullPath='%s'
$t=Get-ScheduledTask|Where-Object{($_.TaskPath+$_.TaskName)-eq $fullPath}|Select-Object -First 1
if(-not $t){Write-Error "Task not found: $fullPath";exit 1}
$i=$t|Get-ScheduledTaskInfo
$lr='';$nr='';$res=''
if($i){
  if($i.LastRunTime.Year -gt 1601){$lr=$i.LastRunTime.ToString('o')}
  if($i.NextRunTime.Year -gt 1601){$nr=$i.NextRunTime.ToString('o')}
  $res=[string][int]$i.LastTaskResult
}
$f=$t.TaskPath.TrimEnd('\')
if(-not $f){$f='\'}
$trigs=@($t.Triggers|ForEach-Object{
  $c=$_.CimClass.CimClassName-replace'MSFT_Task','' -replace'Trigger',''
  switch($c){
    'Registration'{'At task creation'}
    'Boot'{'At startup'}
    'Logon'{'At log on'}
    'Idle'{'On idle'}
    'Time'{'One time'}
    'Daily'{'Daily'}
    'Weekly'{'Weekly'}
    'Monthly'{'Monthly'}
    'Event'{'On event'}
    'SessionStateChange'{'On session change'}
    default{$c}
  }
})
$trigB64=($trigs|ForEach-Object{B $_})-join'|'
Write-Output ((B $t.TaskName)+$U+(B($t.TaskPath+$t.TaskName))+$U+(B $f)+$U+$t.State.ToString().ToLower()+$U+(B $t.Author)+$U+(B $t.Description)+$U+$lr+$U+$nr+$U+$res+$U+$trigB64)
$t.Triggers|ForEach-Object{
  $c=$_.CimClass.CimClassName-replace'MSFT_Task','' -replace'Trigger',''
  $type=switch($c){
    'Registration'{'registration'}
    'Boot'{'boot'}
    'Logon'{'logon'}
    'Idle'{'idle'}
    'Time'{'time'}
    'Daily'{'daily'}
    'Weekly'{'weekly'}
    'Monthly'{'monthly'}
    'Event'{'event'}
    'SessionStateChange'{'session_change'}
    default{$c.ToLower()}
  }
  $en=if($_.Enabled){'true'}else{'false'}
  Write-Output ('TRIG'+$U+$type+$U+$en+$U+(B $_.StartBoundary))
}
$t.Actions|ForEach-Object{
  $atype=if($_.CimClass.CimClassName-eq'MSFT_TaskExecAction'){'execute'}
         else{$_.CimClass.CimClassName.ToLower()-replace'MSFT_Task','' -replace'Action',''}
  Write-Output ('ACT'+$U+$atype+$U+(B $_.Execute)+$U+(B $_.Arguments))
}`, escapedPath)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	output, err := cmd.Output()
	if err != nil {
		errMsg := fmt.Sprintf("task not found: %s: %v", path, err)
		if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
			errMsg = fmt.Sprintf("task not found: %s: %s", path, strings.TrimSpace(string(exitErr.Stderr)))
		}
		return NewErrorResult(fmt.Errorf("%s", errMsg), time.Since(startTime).Milliseconds())
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 0 {
		return NewErrorResult(fmt.Errorf("task not found: %s", path), time.Since(startTime).Milliseconds())
	}

	// Parse the first line as the base task info.
	fields := strings.Split(strings.TrimSpace(lines[0]), "\x1f")
	if len(fields) < 9 {
		return NewErrorResult(fmt.Errorf("invalid task output: %d fields", len(fields)), time.Since(startTime).Milliseconds())
	}

	var lastResult *int
	if fields[8] != "" {
		v, _ := strconv.Atoi(fields[8])
		lastResult = &v
	}

	// Build detail as map[string]any so the API normalizer gets
	// structured triggers/actions.
	detail := map[string]any{
		"name":        decB64(fields[0]),
		"path":        decB64(fields[1]),
		"folder":      decB64(fields[2]),
		"status":      fields[3],
		"author":      decB64(fields[4]),
		"description": decB64(fields[5]),
	}
	if fields[6] != "" {
		detail["lastRun"] = fields[6]
	}
	if fields[7] != "" {
		detail["nextRun"] = fields[7]
	}
	if lastResult != nil {
		detail["lastResult"] = *lastResult
	}

	// Parse TRIG and ACT lines.
	var triggers []map[string]any
	var actions []map[string]any
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		parts := strings.Split(line, "\x1f")
		if len(parts) < 2 {
			continue
		}
		switch parts[0] {
		case "TRIG":
			if len(parts) >= 4 {
				trig := map[string]any{
					"type":    parts[1],
					"enabled": parts[2] == "true",
				}
				if sch := decB64(parts[3]); sch != "" {
					trig["schedule"] = sch
				}
				triggers = append(triggers, trig)
			}
		case "ACT":
			if len(parts) >= 4 {
				act := map[string]any{
					"type": parts[1],
				}
				if p := decB64(parts[2]); p != "" {
					act["path"] = p
				}
				if a := decB64(parts[3]); a != "" {
					act["arguments"] = a
				}
				actions = append(actions, act)
			}
		}
	}
	if triggers == nil {
		triggers = []map[string]any{}
	}
	if actions == nil {
		actions = []map[string]any{}
	}
	detail["triggers"] = triggers
	detail["actions"] = actions

	return NewSuccessResult(detail, time.Since(startTime).Milliseconds())
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

func getTaskHistoryOS(path string, limit int, startTime time.Time) CommandResult {
	if path == "" {
		return NewErrorResult(fmt.Errorf("task path is required"), time.Since(startTime).Milliseconds())
	}

	escapedPath := strings.ReplaceAll(path, "'", "''")
	script := fmt.Sprintf(`$taskPath = '%s'
$limit = %d
$maxScan = 2000
$events = Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -ErrorAction SilentlyContinue -MaxEvents $maxScan
$history = @()
foreach ($event in $events) {
  try {
    $xml = [xml]$event.ToXml()
    $taskNode = $xml.Event.EventData.Data | Where-Object { $_.Name -eq 'TaskName' } | Select-Object -First 1
    if (-not $taskNode) { continue }
    $eventTaskPath = [string]$taskNode.'#text'
    if ($eventTaskPath -ne $taskPath) { continue }

    $resultCodeNode = $xml.Event.EventData.Data | Where-Object { $_.Name -eq 'ResultCode' } | Select-Object -First 1
    $resultCode = $null
    if ($resultCodeNode) {
      $rawResult = [string]$resultCodeNode.'#text'
      if ($rawResult -match '^0x[0-9a-fA-F]+$') {
        $resultCode = [int]$rawResult
      } elseif ($rawResult -match '^-?\d+$') {
        $resultCode = [int]$rawResult
      }
    }

    $history += [PSCustomObject]@{
      id = [string]$event.RecordId
      eventId = [int]$event.Id
      timestamp = $event.TimeCreated.ToString('o')
      level = [string]$event.LevelDisplayName
      message = [string]$event.Message
      resultCode = $resultCode
    }
    if ($history.Count -ge $limit) { break }
  } catch {
    continue
  }
}

$history | ConvertTo-Json -Depth 4 -Compress`, escapedPath, limit)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	output, err := cmd.Output()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read task history: %w", err), time.Since(startTime).Milliseconds())
	}

	outputText := strings.TrimSpace(string(output))
	if outputText == "" {
		return NewSuccessResult(TaskHistoryResponse{
			History: []TaskHistoryEntry{},
			Path:    path,
			Total:   0,
		}, time.Since(startTime).Milliseconds())
	}

	history := []TaskHistoryEntry{}
	if err := json.Unmarshal([]byte(outputText), &history); err != nil {
		var single TaskHistoryEntry
		if errSingle := json.Unmarshal([]byte(outputText), &single); errSingle != nil {
			return NewErrorResult(fmt.Errorf("failed to parse task history: %w", err), time.Since(startTime).Milliseconds())
		}
		history = []TaskHistoryEntry{single}
	}

	return NewSuccessResult(TaskHistoryResponse{
		History: history,
		Path:    path,
		Total:   len(history),
	}, time.Since(startTime).Milliseconds())
}
