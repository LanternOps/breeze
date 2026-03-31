//go:build linux

package collectors

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func (c *ChangeTrackerCollector) collectStartupItems(ctx context.Context) ([]TrackedStartupItem, error) {
	var combinedErr error
	items := make([]TrackedStartupItem, 0)

	// systemd services enabled at boot.
	output, err := runCollectorOutputWithContext(
		ctx,
		collectorShortCommandTimeout,
		"systemctl",
		"list-unit-files",
		"--type=service",
		"--state=enabled,enabled-runtime,static,indirect,generated,linked,linked-runtime",
		"--no-legend",
		"--no-pager",
		"--plain",
	)
	if err != nil {
		combinedErr = errors.Join(combinedErr, fmt.Errorf("systemctl startup query failed: %w", err))
	} else {
		scanner := newCollectorScanner(output)
		for scanner.Scan() {
			fields := strings.Fields(strings.TrimSpace(scanner.Text()))
			if len(fields) < 1 {
				continue
			}
			unit := strings.TrimSpace(fields[0])
			if !isValidCollectorServiceUnit(unit) {
				continue
			}
			name := strings.TrimSuffix(unit, ".service")
			items = append(items, TrackedStartupItem{
				Name:    truncateCollectorString(name),
				Type:    "systemd",
				Path:    truncateCollectorString(unit),
				Enabled: true,
			})
			if len(items) >= collectorResultLimit {
				break
			}
		}
		if err := scanner.Err(); err != nil {
			combinedErr = errors.Join(combinedErr, fmt.Errorf("systemctl startup parse failed: %w", err))
		}
	}

	// @reboot cron entries.
	cronFiles, err := discoverLinuxCronFiles()
	if err != nil {
		combinedErr = errors.Join(combinedErr, err)
	} else {
		for _, path := range cronFiles {
			rebootEntries, entryErr := parseCronEntries(path, true)
			if entryErr != nil {
				combinedErr = errors.Join(combinedErr, entryErr)
				continue
			}
			for _, entry := range rebootEntries {
				items = append(items, TrackedStartupItem{
					Name:    entry.name,
					Type:    "cron",
					Path:    fmt.Sprintf("%s:%d", path, entry.lineNumber),
					Enabled: true,
				})
			}
		}
	}

	if len(items) == 0 && combinedErr != nil {
		return nil, combinedErr
	}
	return items, nil
}

func (c *ChangeTrackerCollector) collectScheduledTasks(ctx context.Context) ([]TrackedScheduledTask, error) {
	var combinedErr error
	tasks := make([]TrackedScheduledTask, 0)

	cronFiles, err := discoverLinuxCronFiles()
	if err != nil {
		combinedErr = errors.Join(combinedErr, err)
	} else {
		for _, path := range cronFiles {
			entries, entryErr := parseCronEntries(path, false)
			if entryErr != nil {
				combinedErr = errors.Join(combinedErr, entryErr)
				continue
			}
			for _, entry := range entries {
				tasks = append(tasks, TrackedScheduledTask{
					Name:     entry.name,
					Path:     fmt.Sprintf("%s:%d", path, entry.lineNumber),
					Status:   "active",
					Schedule: entry.schedule,
					Command:  entry.command,
				})
			}
		}
	}

	// systemd timers.
	timerOut, timerErr := runCollectorOutputWithContext(
		ctx,
		collectorShortCommandTimeout,
		"systemctl",
		"list-timers",
		"--all",
		"--no-legend",
		"--no-pager",
		"--plain",
	)
	if timerErr != nil {
		combinedErr = errors.Join(combinedErr, fmt.Errorf("systemctl timer query failed: %w", timerErr))
	} else {
		scanner := newCollectorScanner(timerOut)
		for scanner.Scan() {
			fields := strings.Fields(strings.TrimSpace(scanner.Text()))
			if len(fields) < 2 {
				continue
			}
			timerUnit := fields[len(fields)-2]
			activates := fields[len(fields)-1]
			if !isValidCollectorTimerUnit(timerUnit) {
				continue
			}

			schedule := ""
			if len(fields) >= 2 {
				schedule = strings.Join(fields[0:2], " ")
			}
			tasks = append(tasks, TrackedScheduledTask{
				Name:     truncateCollectorString(strings.TrimSuffix(timerUnit, ".timer")),
				Path:     truncateCollectorString(timerUnit),
				Status:   "active",
				Schedule: truncateCollectorString(schedule),
				Command:  truncateCollectorString(activates),
			})
			if len(tasks) >= collectorResultLimit {
				break
			}
		}
		if err := scanner.Err(); err != nil {
			combinedErr = errors.Join(combinedErr, fmt.Errorf("systemctl timer parse failed: %w", err))
		}
	}

	if len(tasks) == 0 && combinedErr != nil {
		return nil, combinedErr
	}
	return tasks, nil
}

func isValidCollectorServiceUnit(unit string) bool {
	return unit != "" &&
		len(unit) <= collectorStringLimit &&
		strings.HasSuffix(unit, ".service") &&
		!strings.ContainsAny(unit, " \t\r\n/\\") &&
		!strings.Contains(unit, "..")
}

func isValidCollectorTimerUnit(unit string) bool {
	return unit != "" &&
		len(unit) <= collectorStringLimit &&
		strings.HasSuffix(unit, ".timer") &&
		!strings.ContainsAny(unit, " \t\r\n/\\") &&
		!strings.Contains(unit, "..")
}

func (c *ChangeTrackerCollector) collectUserAccounts(_ context.Context) ([]TrackedUserAccount, error) {
	passwdData, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return nil, fmt.Errorf("read /etc/passwd: %w", err)
	}

	shadowLockMap := make(map[string]bool)
	if shadowData, shadowErr := os.ReadFile("/etc/shadow"); shadowErr == nil {
		for _, line := range strings.Split(string(shadowData), "\n") {
			parts := strings.Split(line, ":")
			if len(parts) < 2 {
				continue
			}
			username := strings.TrimSpace(parts[0])
			passwordField := strings.TrimSpace(parts[1])
			if username == "" {
				continue
			}
			shadowLockMap[username] = strings.HasPrefix(passwordField, "!") || strings.HasPrefix(passwordField, "*")
		}
	}

	users := make([]TrackedUserAccount, 0)
	for _, line := range strings.Split(string(passwdData), "\n") {
		parts := strings.Split(line, ":")
		if len(parts) < 7 {
			continue
		}

		username := strings.TrimSpace(parts[0])
		if username == "" {
			continue
		}

		uid, uidErr := strconv.Atoi(parts[2])
		if uidErr != nil {
			continue
		}
		// Keep root and regular user accounts to reduce noise from service/system users.
		if uid != 0 && uid < 1000 {
			continue
		}

		fullName := strings.TrimSpace(strings.Split(parts[4], ",")[0])
		shell := strings.TrimSpace(parts[6])
		disabled := shell == "/usr/sbin/nologin" || shell == "/sbin/nologin" || shell == "/bin/false"

		users = append(users, TrackedUserAccount{
			Username: username,
			FullName: fullName,
			Disabled: disabled,
			Locked:   shadowLockMap[username],
		})
	}

	return users, nil
}

type cronEntry struct {
	name       string
	schedule   string
	command    string
	lineNumber int
}

func discoverLinuxCronFiles() ([]string, error) {
	files := []string{"/etc/crontab"}
	patterns := []string{
		"/etc/cron.d/*",
		"/var/spool/cron/*",
		"/var/spool/cron/crontabs/*",
	}

	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			return nil, fmt.Errorf("glob %s: %w", pattern, err)
		}
		files = append(files, matches...)
	}
	return files, nil
}

func parseCronEntries(path string, onlyReboot bool) ([]cronEntry, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("open cron file %s: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	entries := make([]cronEntry, 0)
	lineNumber := 0

	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		if strings.HasPrefix(fields[0], "@") {
			schedule := fields[0]
			if onlyReboot && schedule != "@reboot" {
				continue
			}
			commandStart := 1
			if isSystemCronPath(path) && len(fields) >= 3 {
				commandStart = 2
			}
			command := strings.TrimSpace(strings.Join(fields[commandStart:], " "))
			if command == "" {
				continue
			}
			entries = append(entries, cronEntry{
				name:       cronCommandName(command),
				schedule:   schedule,
				command:    command,
				lineNumber: lineNumber,
			})
			continue
		}

		if onlyReboot {
			continue
		}
		if len(fields) < 6 {
			continue
		}

		schedule := strings.Join(fields[0:5], " ")
		commandStart := 5
		if isSystemCronPath(path) && len(fields) >= 7 {
			commandStart = 6
		}
		command := strings.TrimSpace(strings.Join(fields[commandStart:], " "))
		if command == "" {
			continue
		}

		entries = append(entries, cronEntry{
			name:       cronCommandName(command),
			schedule:   schedule,
			command:    command,
			lineNumber: lineNumber,
		})
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan cron file %s: %w", path, err)
	}
	return entries, nil
}

func cronCommandName(command string) string {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return "cron-task"
	}
	return filepath.Base(fields[0])
}

func isSystemCronPath(path string) bool {
	return path == "/etc/crontab" || strings.HasPrefix(path, "/etc/cron.d/")
}
