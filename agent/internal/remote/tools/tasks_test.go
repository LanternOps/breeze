package tools

import "testing"

func TestValidateTaskFolderAndPath(t *testing.T) {
	t.Parallel()

	if got, err := validateTaskFolder("\\Microsoft\\Windows"); err != nil || got != "\\Microsoft\\Windows" {
		t.Fatalf("validateTaskFolder valid = %q, %v", got, err)
	}
	if _, err := validateTaskFolder("relative"); err == nil {
		t.Fatal("expected relative folder to fail")
	}
	if _, err := validateTaskFolder("\\..\\evil"); err == nil {
		t.Fatal("expected traversal folder to fail")
	}

	if got, err := validateTaskPath("\\Microsoft\\Windows\\Defrag\\ScheduledDefrag"); err != nil || got == "" {
		t.Fatalf("validateTaskPath valid failed: %v", err)
	}
	if _, err := validateTaskPath("ScheduledDefrag"); err == nil {
		t.Fatal("expected relative task path to fail")
	}
	if _, err := validateTaskPath("\\bad\npath"); err == nil {
		t.Fatal("expected control characters to fail")
	}
}
