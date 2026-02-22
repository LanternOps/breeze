//go:build windows

package collectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

type winScheduledTask struct {
	Name     string `json:"Name"`
	Path     string `json:"Path"`
	Status   string `json:"Status"`
	Schedule string `json:"Schedule"`
	Command  string `json:"Command"`
}

type winUserAccount struct {
	Name     string `json:"Name"`
	FullName string `json:"FullName"`
	Disabled bool   `json:"Disabled"`
	Lockout  bool   `json:"Lockout"`
}

func (c *ChangeTrackerCollector) collectStartupItems(_ context.Context) ([]TrackedStartupItem, error) {
	var combinedErr error
	seen := make(map[string]struct{})
	items := make([]TrackedStartupItem, 0)

	registryItems, err := collectRegistryRunKeys()
	if err != nil {
		combinedErr = errors.Join(combinedErr, err)
	} else {
		for _, item := range registryItems {
			tracked := TrackedStartupItem{
				Name:    item.Name,
				Type:    item.Type,
				Path:    item.Path,
				Enabled: item.Enabled,
			}
			key := startupKey(tracked)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			items = append(items, tracked)
		}
	}

	startupFolderItems, err := collectStartupFolderItems()
	if err != nil {
		combinedErr = errors.Join(combinedErr, err)
	} else {
		for _, item := range startupFolderItems {
			tracked := TrackedStartupItem{
				Name:    item.Name,
				Type:    item.Type,
				Path:    item.Path,
				Enabled: item.Enabled,
			}
			key := startupKey(tracked)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			items = append(items, tracked)
		}
	}

	if len(items) == 0 && combinedErr != nil {
		return nil, combinedErr
	}
	return items, nil
}

func (c *ChangeTrackerCollector) collectScheduledTasks(ctx context.Context) ([]TrackedScheduledTask, error) {
	psScript := `
$tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
  $actions = @($_.Actions | ForEach-Object {
    $exec = [string]$_.Execute
    $args = [string]$_.Arguments
    if ($args) { "$exec $args" } else { $exec }
  }) -join '; '
  $triggers = @($_.Triggers | ForEach-Object {
    if ($_.StartBoundary) { [string]$_.StartBoundary } else { $_.ToString() }
  }) -join '; '
  [PSCustomObject]@{
    Name     = [string]$_.TaskName
    Path     = [string]$_.TaskPath
    Status   = [string]$_.State
    Schedule = [string]$triggers
    Command  = [string]$actions
  }
}
$tasks | ConvertTo-Json -Compress -Depth 4
`

	rows, err := runWindowsJSON[winScheduledTask](ctx, psScript)
	if err != nil {
		return nil, err
	}

	tasks := make([]TrackedScheduledTask, 0, len(rows))
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		if name == "" {
			continue
		}
		tasks = append(tasks, TrackedScheduledTask{
			Name:     name,
			Path:     strings.TrimSpace(row.Path),
			Status:   strings.ToLower(strings.TrimSpace(row.Status)),
			Schedule: strings.TrimSpace(row.Schedule),
			Command:  strings.TrimSpace(row.Command),
		})
	}

	return tasks, nil
}

func (c *ChangeTrackerCollector) collectUserAccounts(ctx context.Context) ([]TrackedUserAccount, error) {
	psScript := `
Get-CimInstance Win32_UserAccount -Filter "LocalAccount=True" -ErrorAction SilentlyContinue |
  Select-Object Name, FullName, Disabled, Lockout |
  ConvertTo-Json -Compress -Depth 2
`

	rows, err := runWindowsJSON[winUserAccount](ctx, psScript)
	if err != nil {
		return nil, err
	}

	users := make([]TrackedUserAccount, 0, len(rows))
	for _, row := range rows {
		username := strings.TrimSpace(row.Name)
		if username == "" {
			continue
		}
		users = append(users, TrackedUserAccount{
			Username: username,
			FullName: strings.TrimSpace(row.FullName),
			Disabled: row.Disabled,
			Locked:   row.Lockout,
		})
	}
	return users, nil
}

func runWindowsJSON[T any](ctx context.Context, script string) ([]T, error) {
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("powershell execution failed: %w", err)
	}

	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" || trimmed == "null" {
		return []T{}, nil
	}

	var rows []T
	if err := json.Unmarshal([]byte(trimmed), &rows); err != nil {
		var single T
		if errSingle := json.Unmarshal([]byte(trimmed), &single); errSingle != nil {
			return nil, fmt.Errorf("failed to parse powershell JSON: %w", err)
		}
		rows = []T{single}
	}
	return rows, nil
}
