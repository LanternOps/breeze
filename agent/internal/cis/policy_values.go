package cis

import "fmt"

// policyInt reads one value of the security package's password-policy record.
// A key the collector did not report is unknown, never 0: reading missing keys
// as 0 failed CIS 1.1.2-1.1.4 on every Windows device (#9597).
func policyInt(policy map[string]any, key string) (int, bool) {
	switch v := policy[key].(type) {
	case int, int64, float64:
		return intFromAny(v), true
	default:
		return 0, false
	}
}

func policyValueMissing(result CheckResult, what string) CheckResult {
	result.Status = "error"
	result.Message = fmt.Sprintf("password policy did not report the %s", what)
	return result
}

// intFromAny converts a map value to int, handling float64 from JSON and int types.
func intFromAny(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return 0
	}
}
