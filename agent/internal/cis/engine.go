package cis

import (
	"time"
)

// CheckResult represents the outcome of a single CIS benchmark check.
type CheckResult struct {
	CheckID     string         `json:"checkId"`
	Title       string         `json:"title"`
	Severity    string         `json:"severity"` // low, medium, high, critical
	Status      string         `json:"status"`   // pass, fail, not_applicable, error
	Evidence    map[string]any `json:"evidence,omitempty"`
	Remediation *Remediation   `json:"remediation,omitempty"`
	Message     string         `json:"message,omitempty"`
}

// Remediation describes the automatic fix available for a failed check.
type Remediation struct {
	Action       string         `json:"action,omitempty"`
	CommandType  string         `json:"commandType,omitempty"`
	Payload      map[string]any `json:"payload,omitempty"`
	RollbackHint string         `json:"rollbackHint,omitempty"`
}

// BenchmarkOutput is the top-level result returned by RunBenchmark.
type BenchmarkOutput struct {
	CheckedAt    string         `json:"checkedAt"`
	Findings     []CheckResult  `json:"findings"`
	TotalChecks  int            `json:"totalChecks"`
	PassedChecks int            `json:"passedChecks"`
	FailedChecks int            `json:"failedChecks"`
	Score        int            `json:"score"`
	Summary      map[string]any `json:"summary"`
}

// RemediationResult is the outcome of applying a single remediation action.
type RemediationResult struct {
	CheckID      string         `json:"checkId"`
	Action       string         `json:"action"`
	Success      bool           `json:"success"`
	BeforeState  map[string]any `json:"beforeState,omitempty"`
	AfterState   map[string]any `json:"afterState,omitempty"`
	RollbackHint string         `json:"rollbackHint,omitempty"`
	Details      map[string]any `json:"details,omitempty"`
	Error        string         `json:"error,omitempty"`
}

// Check is a single CIS benchmark check definition.
type Check struct {
	ID       string
	Title    string
	Severity string
	Level    string // "l1" or "l2"
	Fn       func() CheckResult
}

// RunBenchmark runs all registered checks for this OS, filtering by level and exclusions.
func RunBenchmark(level string, exclusions []string) BenchmarkOutput {
	return runChecks(platformChecks(), level, exclusions)
}

// runChecks is the core runner, separated for testability.
func runChecks(checks []Check, level string, exclusions []string) BenchmarkOutput {
	excludeSet := make(map[string]bool, len(exclusions))
	for _, e := range exclusions {
		excludeSet[e] = true
	}

	var findings []CheckResult
	passed := 0
	failed := 0

	for _, c := range checks {
		if excludeSet[c.ID] {
			continue
		}
		if !levelIncludes(level, c.Level) {
			continue
		}

		result := c.Fn()
		findings = append(findings, result)

		switch result.Status {
		case "pass":
			passed++
		case "fail":
			failed++
		}
	}

	total := len(findings)
	score := 0
	if total > 0 {
		score = (passed * 100) / total
	}

	return BenchmarkOutput{
		CheckedAt:    time.Now().UTC().Format(time.RFC3339),
		Findings:     findings,
		TotalChecks:  total,
		PassedChecks: passed,
		FailedChecks: failed,
		Score:        score,
		Summary:      map[string]any{},
	}
}

// Remediate runs a specific remediation action by checkId.
func Remediate(checkID, action string, payload map[string]any) RemediationResult {
	return platformRemediate(checkID, action, payload)
}

// levelIncludes returns true if the requested level includes checks at checkLevel.
// l1 runs only l1 checks; l2 runs both l1 and l2 checks.
func levelIncludes(requested, checkLevel string) bool {
	if requested == "" || requested == "l2" {
		return true
	}
	return checkLevel == "l1"
}
