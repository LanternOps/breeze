//go:build darwin

package collectors

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

func (c *ChangeTrackerCollector) collectStartupItems(_ context.Context) ([]TrackedStartupItem, error) {
	items := make([]TrackedStartupItem, 0)

	paths := []struct {
		glob string
		kind string
	}{
		{glob: "/Library/LaunchDaemons/*.plist", kind: "launch_daemon"},
		{glob: "/Library/LaunchAgents/*.plist", kind: "launch_agent"},
		{glob: "/Users/*/Library/LaunchAgents/*.plist", kind: "launch_agent"},
	}

	for _, path := range paths {
		matches, err := filepath.Glob(path.glob)
		if err != nil {
			return nil, fmt.Errorf("glob %s: %w", path.glob, err)
		}
		for _, match := range matches {
			name := strings.TrimSuffix(filepath.Base(match), filepath.Ext(match))
			if name == "" {
				continue
			}
			items = append(items, TrackedStartupItem{
				Name:    name,
				Type:    path.kind,
				Path:    match,
				Enabled: true,
			})
		}
	}

	return items, nil
}

func (c *ChangeTrackerCollector) collectScheduledTasks(ctx context.Context) ([]TrackedScheduledTask, error) {
	tasks := make([]TrackedScheduledTask, 0)

	cmd := exec.CommandContext(ctx, "crontab", "-l")
	output, err := cmd.Output()
	if err != nil {
		// "no crontab for <user>" exits non-zero; that is expected.
		if exitErr, ok := err.(*exec.ExitError); ok && strings.Contains(string(exitErr.Stderr), "no crontab") {
			return tasks, nil
		}
		return nil, fmt.Errorf("crontab -l failed: %w", err)
	}
	for _, entry := range parseDarwinCrontab(string(output)) {
		tasks = append(tasks, entry)
	}

	return tasks, nil
}

func (c *ChangeTrackerCollector) collectUserAccounts(ctx context.Context) ([]TrackedUserAccount, error) {
	cmd := exec.CommandContext(ctx, "dscl", ".", "-list", "/Users", "UniqueID")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("dscl user query failed: %w", err)
	}

	users := make([]TrackedUserAccount, 0)
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		fields := strings.Fields(strings.TrimSpace(scanner.Text()))
		if len(fields) < 2 {
			continue
		}
		username := fields[0]
		if username == "" || strings.HasPrefix(username, "_") {
			continue
		}
		uid := fields[1]
		if uid != "0" {
			uidInt := 0
			for _, ch := range uid {
				if ch < '0' || ch > '9' {
					uidInt = 0
					break
				}
				uidInt = uidInt*10 + int(ch-'0')
			}
			if uidInt < 500 {
				continue
			}
		}
		users = append(users, TrackedUserAccount{
			Username: username,
			Disabled: false,
			Locked:   false,
		})
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan dscl output: %w", err)
	}
	return users, nil
}

func parseDarwinCrontab(output string) []TrackedScheduledTask {
	tasks := make([]TrackedScheduledTask, 0)
	scanner := bufio.NewScanner(strings.NewReader(output))
	lineNumber := 0

	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}

		command := strings.Join(fields[5:], " ")
		schedule := strings.Join(fields[0:5], " ")
		name := filepath.Base(fields[5])
		if name == "" {
			name = "cron-task"
		}

		tasks = append(tasks, TrackedScheduledTask{
			Name:     name,
			Path:     fmt.Sprintf("user-crontab:%d", lineNumber),
			Status:   "active",
			Schedule: schedule,
			Command:  command,
		})
	}

	return tasks
}
