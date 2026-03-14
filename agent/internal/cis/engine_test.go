package cis

import (
	"testing"
)

func TestLevelIncludes(t *testing.T) {
	tests := []struct {
		requested  string
		checkLevel string
		want       bool
	}{
		{"l1", "l1", true},
		{"l1", "l2", false},
		{"l2", "l1", true},
		{"l2", "l2", true},
		{"", "l1", true},
		{"", "l2", true},
	}

	for _, tt := range tests {
		got := levelIncludes(tt.requested, tt.checkLevel)
		if got != tt.want {
			t.Errorf("levelIncludes(%q, %q) = %v, want %v", tt.requested, tt.checkLevel, got, tt.want)
		}
	}
}

func TestRunChecks_ExclusionFiltering(t *testing.T) {
	checks := []Check{
		{ID: "1.0", Title: "Check A", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "1.0", Title: "Check A", Severity: "low", Status: "pass"}
		}},
		{ID: "2.0", Title: "Check B", Severity: "high", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "2.0", Title: "Check B", Severity: "high", Status: "fail", Message: "not compliant"}
		}},
		{ID: "3.0", Title: "Check C", Severity: "medium", Level: "l2", Fn: func() CheckResult {
			return CheckResult{CheckID: "3.0", Title: "Check C", Severity: "medium", Status: "pass"}
		}},
	}

	// Run with no exclusions, l2 (all checks).
	out := runChecks(checks, "l2", nil)
	if out.TotalChecks != 3 {
		t.Errorf("expected 3 total checks, got %d", out.TotalChecks)
	}
	if out.PassedChecks != 2 {
		t.Errorf("expected 2 passed checks, got %d", out.PassedChecks)
	}
	if out.FailedChecks != 1 {
		t.Errorf("expected 1 failed check, got %d", out.FailedChecks)
	}

	// Exclude check 2.0.
	out = runChecks(checks, "l2", []string{"2.0"})
	if out.TotalChecks != 2 {
		t.Errorf("expected 2 total checks after exclusion, got %d", out.TotalChecks)
	}
	if out.PassedChecks != 2 {
		t.Errorf("expected 2 passed checks after exclusion, got %d", out.PassedChecks)
	}
	if out.FailedChecks != 0 {
		t.Errorf("expected 0 failed checks after exclusion, got %d", out.FailedChecks)
	}
}

func TestRunChecks_LevelFiltering(t *testing.T) {
	checks := []Check{
		{ID: "1.0", Title: "L1 Check", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "1.0", Title: "L1 Check", Severity: "low", Status: "pass"}
		}},
		{ID: "2.0", Title: "L2 Check", Severity: "medium", Level: "l2", Fn: func() CheckResult {
			return CheckResult{CheckID: "2.0", Title: "L2 Check", Severity: "medium", Status: "pass"}
		}},
	}

	// L1 only.
	out := runChecks(checks, "l1", nil)
	if out.TotalChecks != 1 {
		t.Errorf("expected 1 check at l1, got %d", out.TotalChecks)
	}
	if out.Findings[0].CheckID != "1.0" {
		t.Errorf("expected check 1.0 at l1, got %s", out.Findings[0].CheckID)
	}

	// L2 includes both.
	out = runChecks(checks, "l2", nil)
	if out.TotalChecks != 2 {
		t.Errorf("expected 2 checks at l2, got %d", out.TotalChecks)
	}
}

func TestRunChecks_ScoreCalculation(t *testing.T) {
	checks := []Check{
		{ID: "1.0", Title: "A", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "1.0", Status: "pass"}
		}},
		{ID: "2.0", Title: "B", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "2.0", Status: "fail"}
		}},
		{ID: "3.0", Title: "C", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "3.0", Status: "pass"}
		}},
		{ID: "4.0", Title: "D", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "4.0", Status: "not_applicable"}
		}},
	}

	out := runChecks(checks, "l1", nil)
	// 2 passed out of 4 total = 50%.
	if out.Score != 50 {
		t.Errorf("expected score 50, got %d", out.Score)
	}
}

func TestRunChecks_Empty(t *testing.T) {
	out := runChecks(nil, "l1", nil)
	if out.TotalChecks != 0 {
		t.Errorf("expected 0 total checks, got %d", out.TotalChecks)
	}
	if out.Score != 0 {
		t.Errorf("expected score 0, got %d", out.Score)
	}
	if out.CheckedAt == "" {
		t.Error("expected CheckedAt to be set")
	}
}

func TestRunChecks_AllExcluded(t *testing.T) {
	checks := []Check{
		{ID: "1.0", Title: "A", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "1.0", Status: "pass"}
		}},
	}

	out := runChecks(checks, "l1", []string{"1.0"})
	if out.TotalChecks != 0 {
		t.Errorf("expected 0 checks when all excluded, got %d", out.TotalChecks)
	}
	if out.Score != 0 {
		t.Errorf("expected score 0 when all excluded, got %d", out.Score)
	}
}

func TestRunChecks_ErrorStatusNotCountedAsPassOrFail(t *testing.T) {
	checks := []Check{
		{ID: "1.0", Title: "A", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "1.0", Status: "error", Message: "something broke"}
		}},
		{ID: "2.0", Title: "B", Severity: "low", Level: "l1", Fn: func() CheckResult {
			return CheckResult{CheckID: "2.0", Status: "pass"}
		}},
	}

	out := runChecks(checks, "l1", nil)
	if out.TotalChecks != 2 {
		t.Errorf("expected 2 total, got %d", out.TotalChecks)
	}
	if out.PassedChecks != 1 {
		t.Errorf("expected 1 passed, got %d", out.PassedChecks)
	}
	if out.FailedChecks != 0 {
		t.Errorf("expected 0 failed, got %d", out.FailedChecks)
	}
	// Score: 1 passed / 2 total = 50%.
	if out.Score != 50 {
		t.Errorf("expected score 50, got %d", out.Score)
	}
}
