package tools

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEscapePowerShellSingleQuoted(t *testing.T) {
	input := "System'; Write-Output hacked; '"
	got := escapePowerShellSingleQuoted(input)
	want := "System''; Write-Output hacked; ''"
	if got != want {
		t.Fatalf("escapePowerShellSingleQuoted() = %q, want %q", got, want)
	}
}

func TestTruncateStringBytesPreservesUTF8(t *testing.T) {
	input := "prefix-🙂-suffix"
	got, truncated := truncateStringBytes(input, 12)
	if !truncated {
		t.Fatal("expected truncation")
	}
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("expected ellipsis suffix, got %q", got)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("expected valid UTF-8 output, got %q", got)
	}
	if len(got) > 12 {
		t.Fatalf("expected output within byte budget, got %d bytes", len(got))
	}
}

func TestSanitizeEventLogEntriesTruncatesLargeMessages(t *testing.T) {
	entries, truncated := sanitizeEventLogEntries([]EventLogEntry{{
		LogName: "System",
		Message: strings.Repeat("A", maxEventLogMessageBytes+128),
		Source:  strings.Repeat("B", maxEventLogFieldBytes+64),
	}})
	if !truncated {
		t.Fatal("expected event-log entry sanitization to report truncation")
	}
	if got := len(entries[0].Message); got > maxEventLogMessageBytes {
		t.Fatalf("expected message to be truncated, got %d bytes", got)
	}
	if got := len(entries[0].Source); got > maxEventLogFieldBytes {
		t.Fatalf("expected source to be truncated, got %d bytes", got)
	}
}

func TestSanitizeRegistryValuesCapsCountAndData(t *testing.T) {
	values := make([]RegistryValue, 0, maxRegistryListEntries+10)
	for i := 0; i < maxRegistryListEntries+10; i++ {
		values = append(values, RegistryValue{
			Name: strings.Repeat("n", maxTaskFieldBytes+10),
			Type: "REG_SZ",
			Data: strings.Repeat("d", maxRegistryValueStringBytes+64),
		})
	}

	sanitized, truncated := sanitizeRegistryValues(values)
	if !truncated {
		t.Fatal("expected registry values to be marked truncated")
	}
	if len(sanitized) != maxRegistryListEntries {
		t.Fatalf("expected %d registry values, got %d", maxRegistryListEntries, len(sanitized))
	}
	if got := len(sanitized[0].Data); got > maxRegistryValueStringBytes {
		t.Fatalf("expected registry value data to be truncated, got %d bytes", got)
	}
}

func TestSanitizeProcessInfoAndList(t *testing.T) {
	raw := ProcessInfo{
		Name:        strings.Repeat("n", maxProcessFieldBytes+20),
		User:        strings.Repeat("u", maxProcessFieldBytes+20),
		Status:      strings.Repeat("s", maxProcessFieldBytes+20),
		CommandLine: strings.Repeat("c", maxProcessCommandLineBytes+20),
	}
	info, truncated := sanitizeProcessInfo(raw)
	if !truncated {
		t.Fatal("expected process info to be truncated")
	}
	if got := len(info.CommandLine); got > maxProcessCommandLineBytes {
		t.Fatalf("expected command line to be truncated, got %d bytes", got)
	}

	list, listTruncated := sanitizeProcessList([]ProcessInfo{raw})
	if !listTruncated {
		t.Fatal("expected process list sanitization to report truncation")
	}
	if len(list) != 1 {
		t.Fatalf("expected one process, got %d", len(list))
	}
}

func TestSanitizeServiceInfoAndList(t *testing.T) {
	services := make([]ServiceInfo, 0, maxServiceListEntries+5)
	for i := 0; i < maxServiceListEntries+5; i++ {
		services = append(services, ServiceInfo{
			Name:        strings.Repeat("n", maxServiceFieldBytes+20),
			DisplayName: strings.Repeat("d", maxServiceFieldBytes+20),
			Account:     strings.Repeat("a", maxServiceFieldBytes+20),
			Path:        strings.Repeat("p", maxServicePathBytes+20),
			Description: strings.Repeat("x", maxServiceDescriptionBytes+20),
		})
	}

	sanitized, truncated := sanitizeServiceList(services)
	if !truncated {
		t.Fatal("expected service list to be truncated")
	}
	if len(sanitized) != maxServiceListEntries {
		t.Fatalf("expected %d services, got %d", maxServiceListEntries, len(sanitized))
	}
	if got := len(sanitized[0].Path); got > maxServicePathBytes {
		t.Fatalf("expected service path to be truncated, got %d bytes", got)
	}
}

func TestSanitizeDriveList(t *testing.T) {
	drives := make([]DriveInfo, 0, maxDriveListEntries+5)
	for i := 0; i < maxDriveListEntries+5; i++ {
		drives = append(drives, DriveInfo{
			Letter:     strings.Repeat("L", maxDriveFieldBytes+10),
			MountPoint: strings.Repeat("M", maxDriveMountPointBytes+10),
			Label:      strings.Repeat("N", maxDriveFieldBytes+10),
			FileSystem: strings.Repeat("F", maxDriveFieldBytes+10),
			DriveType:  strings.Repeat("T", maxDriveFieldBytes+10),
		})
	}

	sanitized, truncated := sanitizeDriveList(drives)
	if !truncated {
		t.Fatal("expected drive list to be truncated")
	}
	if len(sanitized) != maxDriveListEntries {
		t.Fatalf("expected %d drives, got %d", maxDriveListEntries, len(sanitized))
	}
	if got := len(sanitized[0].MountPoint); got > maxDriveMountPointBytes {
		t.Fatalf("expected mount point to be truncated, got %d bytes", got)
	}
}

func TestNewBoundedScannerAcceptsLargeLine(t *testing.T) {
	line := strings.Repeat("x", 128*1024)
	scanner := newBoundedScanner(line)
	if !scanner.Scan() {
		t.Fatal("expected scanner to read large line")
	}
	if scanner.Text() != line {
		t.Fatal("expected scanner to preserve the full line")
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("unexpected scanner error: %v", err)
	}
}

func TestSanitizeScheduledTasksCapsListAndDetailFields(t *testing.T) {
	tasks := make([]ScheduledTask, 0, maxTaskListEntries+5)
	for i := 0; i < maxTaskListEntries+5; i++ {
		tasks = append(tasks, ScheduledTask{
			Name:        strings.Repeat("n", maxTaskFieldBytes+20),
			Path:        strings.Repeat("p", maxRegistryPathBytes+20),
			Description: strings.Repeat("d", maxTaskDescriptionBytes+20),
			Triggers:    []string{strings.Repeat("t", maxTaskFieldBytes+20), strings.Repeat("u", maxTaskFieldBytes+20)},
		})
	}

	sanitized, truncated := sanitizeScheduledTasks(tasks)
	if !truncated {
		t.Fatal("expected scheduled tasks to be marked truncated")
	}
	if len(sanitized) != maxTaskListEntries {
		t.Fatalf("expected %d tasks, got %d", maxTaskListEntries, len(sanitized))
	}
	if got := len(sanitized[0].Description); got > maxTaskDescriptionBytes {
		t.Fatalf("expected task description to be truncated, got %d bytes", got)
	}
	if got := len(sanitized[0].Triggers[0]); got > maxTaskFieldBytes {
		t.Fatalf("expected task trigger to be truncated, got %d bytes", got)
	}
}

func TestSanitizeTaskDetailItemsAndHistory(t *testing.T) {
	items, itemsTruncated := sanitizeTaskDetailItems([]map[string]any{
		{
			"path":      strings.Repeat("p", maxRegistryPathBytes+50),
			"arguments": strings.Repeat("a", maxRegistryPathBytes+50),
		},
	})
	if !itemsTruncated {
		t.Fatal("expected task detail items to be truncated")
	}
	if got := len(items[0]["path"].(string)); got > maxRegistryPathBytes {
		t.Fatalf("expected detail path to be truncated, got %d bytes", got)
	}

	history, historyTruncated := sanitizeTaskHistory([]TaskHistoryEntry{{
		Message: strings.Repeat("m", maxTaskHistoryMessageBytes+50),
	}})
	if !historyTruncated {
		t.Fatal("expected task history to be truncated")
	}
	if got := len(history[0].Message); got > maxTaskHistoryMessageBytes {
		t.Fatalf("expected task history message to be truncated, got %d bytes", got)
	}
}

func TestSanitizeInstallerOutput(t *testing.T) {
	output, truncated := sanitizeInstallerOutput(strings.Repeat("o", maxInstallerOutputBytes+64))
	if !truncated {
		t.Fatal("expected installer output to be truncated")
	}
	if got := len(output); got > maxInstallerOutputBytes {
		t.Fatalf("expected installer output to be truncated, got %d bytes", got)
	}
}
