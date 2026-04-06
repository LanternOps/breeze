package tools

import (
	"bufio"
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	maxToolScannerTokenBytes    = 1024 * 1024
	maxEventLogQueryPage        = 20
	maxEventLogListEntries      = 256
	maxEventLogFieldBytes       = 512
	maxEventLogMessageBytes     = 4096
	maxDriveListEntries         = 256
	maxDriveFieldBytes          = 512
	maxDriveMountPointBytes     = 1024
	maxProcessFieldBytes        = 512
	maxProcessCommandLineBytes  = 4096
	maxServiceListEntries       = 512
	maxServiceFieldBytes        = 512
	maxServicePathBytes         = 2048
	maxServiceDescriptionBytes  = 4096
	maxRegistryListEntries      = 256
	maxRegistryValueReadBytes   = 64 * 1024
	maxRegistryValueStringBytes = 4096
	maxRegistryPathBytes        = 1024
	maxTaskListEntries          = 500
	maxTaskFieldBytes           = 512
	maxTaskDescriptionBytes     = 4096
	maxTaskItemsPerDetail       = 32
	maxTaskHistoryMessageBytes  = 4096
	maxComputerActionTextBytes  = 8192
	maxComputerActionKeyBytes   = 128
	maxComputerActionModifiers  = 8
	maxInstallerOutputBytes     = 32 * 1024
	maxInstallArgBytes          = 4096
	maxInstallMetadataBytes     = 512
	maxUninstallOutputBytes     = 16 * 1024
	maxUninstallErrorBytes      = 32 * 1024
)

func escapePowerShellSingleQuoted(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}

func truncateStringBytes(value string, max int) (string, bool) {
	if max <= 0 {
		return "", value != ""
	}
	if len(value) <= max {
		return value, false
	}

	if max <= 3 {
		cut := max
		for cut > 0 && !utf8.ValidString(value[:cut]) {
			cut--
		}
		return value[:cut], true
	}

	cut := max - 3
	for cut > 0 && !utf8.ValidString(value[:cut]) {
		cut--
	}
	if cut <= 0 {
		return "...", true
	}
	return value[:cut] + "...", true
}

func sanitizeEventLogs(logs []EventLog) ([]EventLog, bool) {
	truncated := false
	if len(logs) > maxEventLogListEntries {
		logs = logs[:maxEventLogListEntries]
		truncated = true
	}

	for i := range logs {
		if v, changed := truncateStringBytes(logs[i].Name, maxEventLogFieldBytes); changed {
			logs[i].Name = v
			truncated = true
		}
		if v, changed := truncateStringBytes(logs[i].DisplayName, maxEventLogFieldBytes); changed {
			logs[i].DisplayName = v
			truncated = true
		}
		if v, changed := truncateStringBytes(logs[i].Retention, maxEventLogFieldBytes); changed {
			logs[i].Retention = v
			truncated = true
		}
	}

	return logs, truncated
}

func sanitizeEventLogEntries(entries []EventLogEntry) ([]EventLogEntry, bool) {
	truncated := false
	for i := range entries {
		if v, changed := truncateStringBytes(entries[i].LogName, maxEventLogFieldBytes); changed {
			entries[i].LogName = v
			truncated = true
		}
		if v, changed := truncateStringBytes(entries[i].Level, maxEventLogFieldBytes); changed {
			entries[i].Level = v
			truncated = true
		}
		if v, changed := truncateStringBytes(entries[i].Source, maxEventLogFieldBytes); changed {
			entries[i].Source = v
			truncated = true
		}
		if v, changed := truncateStringBytes(entries[i].Computer, maxEventLogFieldBytes); changed {
			entries[i].Computer = v
			truncated = true
		}
		if v, changed := truncateStringBytes(entries[i].UserID, maxEventLogFieldBytes); changed {
			entries[i].UserID = v
			truncated = true
		}
		if v, changed := truncateStringBytes(entries[i].Message, maxEventLogMessageBytes); changed {
			entries[i].Message = v
			truncated = true
		}
	}

	return entries, truncated
}

func sanitizeRegistryKeys(keys []RegistryKey) ([]RegistryKey, bool) {
	truncated := false
	if len(keys) > maxRegistryListEntries {
		keys = keys[:maxRegistryListEntries]
		truncated = true
	}

	for i := range keys {
		if v, changed := truncateStringBytes(keys[i].Name, maxTaskFieldBytes); changed {
			keys[i].Name = v
			truncated = true
		}
		if v, changed := truncateStringBytes(keys[i].Path, maxRegistryPathBytes); changed {
			keys[i].Path = v
			truncated = true
		}
		if v, changed := truncateStringBytes(keys[i].LastModified, maxTaskFieldBytes); changed {
			keys[i].LastModified = v
			truncated = true
		}
	}

	return keys, truncated
}

func sanitizeRegistryValues(values []RegistryValue) ([]RegistryValue, bool) {
	truncated := false
	if len(values) > maxRegistryListEntries {
		values = values[:maxRegistryListEntries]
		truncated = true
	}

	for i := range values {
		if v, changed := truncateStringBytes(values[i].Name, maxTaskFieldBytes); changed {
			values[i].Name = v
			truncated = true
		}
		if v, changed := truncateStringBytes(values[i].Type, maxTaskFieldBytes); changed {
			values[i].Type = v
			truncated = true
		}
		if v, changed := truncateStringBytes(values[i].Data, maxRegistryValueStringBytes); changed {
			values[i].Data = v
			truncated = true
		}
	}

	return values, truncated
}

func sanitizeProcessInfo(info ProcessInfo) (ProcessInfo, bool) {
	truncated := false
	if v, changed := truncateStringBytes(info.Name, maxProcessFieldBytes); changed {
		info.Name = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.User, maxProcessFieldBytes); changed {
		info.User = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.Status, maxProcessFieldBytes); changed {
		info.Status = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.CommandLine, maxProcessCommandLineBytes); changed {
		info.CommandLine = v
		truncated = true
	}
	return info, truncated
}

func sanitizeProcessList(processes []ProcessInfo) ([]ProcessInfo, bool) {
	truncated := false
	for i := range processes {
		if sanitized, changed := sanitizeProcessInfo(processes[i]); changed {
			processes[i] = sanitized
			truncated = true
		}
	}
	return processes, truncated
}

func sanitizeServiceInfo(info ServiceInfo) (ServiceInfo, bool) {
	truncated := false
	if v, changed := truncateStringBytes(info.Name, maxServiceFieldBytes); changed {
		info.Name = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.DisplayName, maxServiceFieldBytes); changed {
		info.DisplayName = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.Status, maxServiceFieldBytes); changed {
		info.Status = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.StartupType, maxServiceFieldBytes); changed {
		info.StartupType = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.Account, maxServiceFieldBytes); changed {
		info.Account = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.Path, maxServicePathBytes); changed {
		info.Path = v
		truncated = true
	}
	if v, changed := truncateStringBytes(info.Description, maxServiceDescriptionBytes); changed {
		info.Description = v
		truncated = true
	}
	return info, truncated
}

func sanitizeServiceList(services []ServiceInfo) ([]ServiceInfo, bool) {
	truncated := false
	if len(services) > maxServiceListEntries {
		services = services[:maxServiceListEntries]
		truncated = true
	}
	for i := range services {
		if sanitized, changed := sanitizeServiceInfo(services[i]); changed {
			services[i] = sanitized
			truncated = true
		}
	}
	return services, truncated
}

func sanitizeScheduledTasks(tasks []ScheduledTask) ([]ScheduledTask, bool) {
	truncated := false
	if len(tasks) > maxTaskListEntries {
		tasks = tasks[:maxTaskListEntries]
		truncated = true
	}

	for i := range tasks {
		if v, changed := truncateStringBytes(tasks[i].Name, maxTaskFieldBytes); changed {
			tasks[i].Name = v
			truncated = true
		}
		if v, changed := truncateStringBytes(tasks[i].Path, maxRegistryPathBytes); changed {
			tasks[i].Path = v
			truncated = true
		}
		if v, changed := truncateStringBytes(tasks[i].Folder, maxRegistryPathBytes); changed {
			tasks[i].Folder = v
			truncated = true
		}
		if v, changed := truncateStringBytes(tasks[i].Status, maxTaskFieldBytes); changed {
			tasks[i].Status = v
			truncated = true
		}
		if v, changed := truncateStringBytes(tasks[i].Author, maxTaskFieldBytes); changed {
			tasks[i].Author = v
			truncated = true
		}
		if v, changed := truncateStringBytes(tasks[i].Description, maxTaskDescriptionBytes); changed {
			tasks[i].Description = v
			truncated = true
		}
		for j := range tasks[i].Triggers {
			if v, changed := truncateStringBytes(tasks[i].Triggers[j], maxTaskFieldBytes); changed {
				tasks[i].Triggers[j] = v
				truncated = true
			}
		}
		if len(tasks[i].Triggers) > maxTaskItemsPerDetail {
			tasks[i].Triggers = tasks[i].Triggers[:maxTaskItemsPerDetail]
			truncated = true
		}
	}

	return tasks, truncated
}

func sanitizeTaskHistory(entries []TaskHistoryEntry) ([]TaskHistoryEntry, bool) {
	truncated := false
	for i := range entries {
		if v, changed := truncateStringBytes(entries[i].ID, maxTaskFieldBytes); changed {
			entries[i].ID = v
			truncated = true
		}
		if v, changed := truncateStringBytes(entries[i].Timestamp, maxTaskFieldBytes); changed {
			entries[i].Timestamp = v
			truncated = true
		}
		if v, changed := truncateStringBytes(entries[i].Level, maxTaskFieldBytes); changed {
			entries[i].Level = v
			truncated = true
		}
		if v, changed := truncateStringBytes(entries[i].Message, maxTaskHistoryMessageBytes); changed {
			entries[i].Message = v
			truncated = true
		}
	}

	return entries, truncated
}

func sanitizeTaskDetailItems(items []map[string]any) ([]map[string]any, bool) {
	truncated := false
	if len(items) > maxTaskItemsPerDetail {
		items = items[:maxTaskItemsPerDetail]
		truncated = true
	}

	for _, item := range items {
		for key, value := range item {
			text, ok := value.(string)
			if !ok {
				continue
			}

			limit := maxTaskFieldBytes
			if key == "path" || key == "arguments" || key == "schedule" {
				limit = maxRegistryPathBytes
			}
			if v, changed := truncateStringBytes(text, limit); changed {
				item[key] = v
				truncated = true
			}
		}
	}

	return items, truncated
}

func oversizedRegistryValuePlaceholder(size int) string {
	return fmt.Sprintf("<omitted: registry value is %d bytes; max readable size is %d bytes>", size, maxRegistryValueReadBytes)
}

func sanitizeInstallerOutput(output string) (string, bool) {
	return truncateStringBytes(output, maxInstallerOutputBytes)
}

func sanitizeUninstallOutput(output string) (string, bool) {
	return truncateStringBytes(output, maxUninstallOutputBytes)
}

func newBoundedScanner(input string) *bufio.Scanner {
	scanner := bufio.NewScanner(strings.NewReader(input))
	scanner.Buffer(make([]byte, 0, 64*1024), maxToolScannerTokenBytes)
	return scanner
}

func sanitizeDriveList(drives []DriveInfo) ([]DriveInfo, bool) {
	truncated := false
	if len(drives) > maxDriveListEntries {
		drives = drives[:maxDriveListEntries]
		truncated = true
	}
	for i := range drives {
		if v, changed := truncateStringBytes(drives[i].Letter, maxDriveFieldBytes); changed {
			drives[i].Letter = v
			truncated = true
		}
		if v, changed := truncateStringBytes(drives[i].MountPoint, maxDriveMountPointBytes); changed {
			drives[i].MountPoint = v
			truncated = true
		}
		if v, changed := truncateStringBytes(drives[i].Label, maxDriveFieldBytes); changed {
			drives[i].Label = v
			truncated = true
		}
		if v, changed := truncateStringBytes(drives[i].FileSystem, maxDriveFieldBytes); changed {
			drives[i].FileSystem = v
			truncated = true
		}
		if v, changed := truncateStringBytes(drives[i].DriveType, maxDriveFieldBytes); changed {
			drives[i].DriveType = v
			truncated = true
		}
	}
	return drives, truncated
}
