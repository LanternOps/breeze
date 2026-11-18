package cis

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/security"
)

func TestPolicyIntReadsNumbersAndRejectsEverythingElse(t *testing.T) {
	policy := map[string]any{
		"int":     14,
		"int64":   int64(24),
		"float64": float64(60), // a record that went through JSON
		"string":  "14",
		"nil":     nil,
		"bool":    true,
	}
	for key, want := range map[string]struct {
		n  int
		ok bool
	}{
		"int":     {14, true},
		"int64":   {24, true},
		"float64": {60, true},
		"string":  {0, false},
		"nil":     {0, false},
		"bool":    {0, false},
		"absent":  {0, false},
	} {
		if n, ok := policyInt(policy, key); n != want.n || ok != want.ok {
			t.Errorf("policyInt(%q) = (%d, %v), want (%d, %v)", key, n, ok, want.n, want.ok)
		}
	}
}

// The Windows CIS checks once read keys no collector wrote (maxPasswordAge,
// minPasswordAge, minPasswordLength), so every value came back 0 and CIS
// 1.1.2-1.1.4 failed everywhere (#9597). The checks now read the security
// package's exported key constants; pin their values to what the collectors
// and the API use.
func TestPasswordPolicyKeysMatchTheRecord(t *testing.T) {
	for got, want := range map[string]string{
		security.PasswordPolicyKeyMinLength:         "minLength",
		security.PasswordPolicyKeyMaxAgeDays:        "maxAgeDays",
		security.PasswordPolicyKeyMinAgeDays:        "minAgeDays",
		security.PasswordPolicyKeyHistoryCount:      "historyCount",
		security.PasswordPolicyKeyLockoutThreshold:  "lockoutThreshold",
		security.PasswordPolicyKeyComplexityEnabled: "complexityEnabled",
	} {
		if got != want {
			t.Errorf("key %q, want %q", got, want)
		}
	}
}

// A value the collector did not report is an error, not a failed check.
func TestPolicyValueMissingIsAnError(t *testing.T) {
	got := policyValueMissing(CheckResult{CheckID: "1.1.2"}, "maximum password age")
	if got.Status != "error" || got.CheckID != "1.1.2" || got.Message == "" {
		t.Fatalf("policyValueMissing = %#v, want status error with a message", got)
	}
}
