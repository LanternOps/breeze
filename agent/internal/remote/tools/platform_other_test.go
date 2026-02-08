//go:build !windows

package tools

import (
	"strings"
	"testing"
)

func assertFailedWithMessage(t *testing.T, result CommandResult, expectedSubstring string) {
	t.Helper()

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result.Status)
	}
	if result.ExitCode != 1 {
		t.Fatalf("expected exitCode=1, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Error, expectedSubstring) {
		t.Fatalf("expected error to contain %q, got %q", expectedSubstring, result.Error)
	}
}

func TestScheduledTaskCommands_NonWindowsUnsupported(t *testing.T) {
	expected := "scheduled tasks are only supported on Windows"

	assertFailedWithMessage(t, ListTasks(map[string]any{}), expected)
	assertFailedWithMessage(t, GetTask(map[string]any{}), expected)
	assertFailedWithMessage(t, RunTask(map[string]any{}), expected)
	assertFailedWithMessage(t, EnableTask(map[string]any{}), expected)
	assertFailedWithMessage(t, DisableTask(map[string]any{}), expected)
}

func TestRegistryCommands_NonWindowsUnsupported(t *testing.T) {
	expected := "registry is only supported on Windows"

	assertFailedWithMessage(t, ListRegistryKeys(map[string]any{}), expected)
	assertFailedWithMessage(t, ListRegistryValues(map[string]any{}), expected)
	assertFailedWithMessage(t, GetRegistryValue(map[string]any{}), expected)
	assertFailedWithMessage(t, SetRegistryValue(map[string]any{}), expected)
	assertFailedWithMessage(t, DeleteRegistryValue(map[string]any{}), expected)
}
