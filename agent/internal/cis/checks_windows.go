//go:build windows

package cis

import (
	"fmt"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

func platformChecks() []Check {
	return []Check{
		{
			ID:       "1.1.1",
			Title:    "Ensure 'Enforce password history' is set to '24 or more password(s)'",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkPasswordHistory,
		},
		{
			ID:       "1.1.2",
			Title:    "Ensure 'Maximum password age' is set to '365 or fewer days, but not 0'",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkMaxPasswordAge,
		},
		{
			ID:       "1.1.3",
			Title:    "Ensure 'Minimum password age' is set to '1 or more day(s)'",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkMinPasswordAge,
		},
		{
			ID:       "1.1.4",
			Title:    "Ensure 'Minimum password length' is set to '14 or more character(s)'",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkMinPasswordLength,
		},
		{
			ID:       "2.3.1",
			Title:    "Ensure 'Accounts: Guest account status' is set to 'Disabled'",
			Severity: "high",
			Level:    "l1",
			Fn:       checkGuestAccountDisabled,
		},
		{
			ID:       "9.1.1",
			Title:    "Ensure Windows Firewall is enabled for all profiles",
			Severity: "high",
			Level:    "l1",
			Fn:       checkFirewallEnabled,
		},
		{
			ID:       "2.3.7",
			Title:    "Ensure 'Interactive logon: Do not display last user name' is set to 'Enabled'",
			Severity: "low",
			Level:    "l1",
			Fn:       checkDontDisplayLastUser,
		},
		{
			ID:       "18.4.1",
			Title:    "Ensure 'Apply UAC restrictions to local accounts on network logons' is set to 'Enabled'",
			Severity: "high",
			Level:    "l1",
			Fn:       checkUACLocalAccountFilter,
		},
		{
			ID:       "18.9.4",
			Title:    "Ensure 'Configure registry policy processing' is set to process even if GPOs have not changed",
			Severity: "medium",
			Level:    "l2",
			Fn:       checkRegistryPolicyProcessing,
		},
		{
			ID:       "17.1.1",
			Title:    "Ensure 'Audit Credential Validation' is set to 'Success and Failure'",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkAuditCredentialValidation,
		},
	}
}

// checkPasswordHistory validates CIS 1.1.1 — password history >= 24.
func checkPasswordHistory() CheckResult {
	result := CheckResult{
		CheckID:  "1.1.1",
		Title:    "Ensure 'Enforce password history' is set to '24 or more password(s)'",
		Severity: "medium",
	}

	policy, err := security.CollectPasswordPolicySummary()
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to collect password policy: %s", err.Error())
		return result
	}

	historyCount := intFromAny(policy["historyCount"])
	result.Evidence = map[string]any{"historyCount": historyCount}

	if historyCount >= 24 {
		result.Status = "pass"
		result.Message = fmt.Sprintf("Password history is %d (>= 24)", historyCount)
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("Password history is %d (should be >= 24)", historyCount)
		result.Remediation = &Remediation{
			Action:       "set_local_password_policy",
			CommandType:  "cis_remediation",
			Payload:      map[string]any{"setting": "uniquepw", "value": 24},
			RollbackHint: fmt.Sprintf("net accounts /uniquepw:%d", historyCount),
		}
	}
	return result
}

// checkMaxPasswordAge validates CIS 1.1.2 — max password age <= 365 and != 0.
func checkMaxPasswordAge() CheckResult {
	result := CheckResult{
		CheckID:  "1.1.2",
		Title:    "Ensure 'Maximum password age' is set to '365 or fewer days, but not 0'",
		Severity: "medium",
	}

	policy, err := security.CollectPasswordPolicySummary()
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to collect password policy: %s", err.Error())
		return result
	}

	maxAge := intFromAny(policy["maxPasswordAge"])
	result.Evidence = map[string]any{"maxPasswordAge": maxAge}

	if maxAge > 0 && maxAge <= 365 {
		result.Status = "pass"
		result.Message = fmt.Sprintf("Maximum password age is %d days", maxAge)
	} else {
		result.Status = "fail"
		if maxAge == 0 {
			result.Message = "Maximum password age is 0 (passwords never expire)"
		} else {
			result.Message = fmt.Sprintf("Maximum password age is %d days (should be 1-365)", maxAge)
		}
	}
	return result
}

// checkMinPasswordAge validates CIS 1.1.3 — min password age >= 1.
func checkMinPasswordAge() CheckResult {
	result := CheckResult{
		CheckID:  "1.1.3",
		Title:    "Ensure 'Minimum password age' is set to '1 or more day(s)'",
		Severity: "medium",
	}

	policy, err := security.CollectPasswordPolicySummary()
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to collect password policy: %s", err.Error())
		return result
	}

	minAge := intFromAny(policy["minPasswordAge"])
	result.Evidence = map[string]any{"minPasswordAge": minAge}

	if minAge >= 1 {
		result.Status = "pass"
		result.Message = fmt.Sprintf("Minimum password age is %d day(s)", minAge)
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("Minimum password age is %d (should be >= 1)", minAge)
	}
	return result
}

// checkMinPasswordLength validates CIS 1.1.4 — min password length >= 14.
func checkMinPasswordLength() CheckResult {
	result := CheckResult{
		CheckID:  "1.1.4",
		Title:    "Ensure 'Minimum password length' is set to '14 or more character(s)'",
		Severity: "medium",
	}

	policy, err := security.CollectPasswordPolicySummary()
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to collect password policy: %s", err.Error())
		return result
	}

	minLen := intFromAny(policy["minPasswordLength"])
	result.Evidence = map[string]any{"minPasswordLength": minLen}

	if minLen >= 14 {
		result.Status = "pass"
		result.Message = fmt.Sprintf("Minimum password length is %d characters", minLen)
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("Minimum password length is %d (should be >= 14)", minLen)
	}
	return result
}

// checkGuestAccountDisabled validates CIS 2.3.1 — guest account is disabled.
func checkGuestAccountDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.1",
		Title:    "Ensure 'Accounts: Guest account status' is set to 'Disabled'",
		Severity: "high",
	}

	output, err := security.RunCommand(8*time.Second,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-LocalUser -Name Guest).Enabled")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to query guest account: %s", err.Error())
		return result
	}

	enabled := strings.TrimSpace(strings.ToLower(output))
	result.Evidence = map[string]any{"guestEnabled": enabled}

	if enabled == "false" {
		result.Status = "pass"
		result.Message = "Guest account is disabled"
	} else {
		result.Status = "fail"
		result.Message = "Guest account is enabled"
		result.Remediation = &Remediation{
			Action:       "disable_local_account",
			CommandType:  "cis_remediation",
			Payload:      map[string]any{"account": "guest"},
			RollbackHint: "net user guest /active:yes",
		}
	}
	return result
}

// checkFirewallEnabled validates CIS 9.1.1 — all firewall profiles enabled.
func checkFirewallEnabled() CheckResult {
	result := CheckResult{
		CheckID:  "9.1.1",
		Title:    "Ensure Windows Firewall is enabled for all profiles",
		Severity: "high",
	}

	enabled, err := security.GetFirewallStatus()
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to check firewall: %s", err.Error())
		return result
	}

	result.Evidence = map[string]any{"firewallEnabled": enabled}

	if enabled {
		result.Status = "pass"
		result.Message = "Windows Firewall is enabled"
	} else {
		result.Status = "fail"
		result.Message = "Windows Firewall is not enabled for all profiles"
		result.Remediation = &Remediation{
			Action:       "set_firewall_state",
			CommandType:  "cis_remediation",
			Payload:      map[string]any{"state": "on"},
			RollbackHint: "netsh advfirewall set allprofiles state off",
		}
	}
	return result
}

// checkDontDisplayLastUser validates CIS 2.3.7 — don't display last username at logon.
func checkDontDisplayLastUser() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.7",
		Title:    "Ensure 'Interactive logon: Do not display last user name' is set to 'Enabled'",
		Severity: "low",
	}

	output, err := security.RunCommand(8*time.Second,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'DontDisplayLastUserName' -ErrorAction SilentlyContinue).DontDisplayLastUserName")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to read registry: %s", err.Error())
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"dontDisplayLastUserName": val}

	if val == "1" {
		result.Status = "pass"
		result.Message = "Last user name is not displayed at logon"
	} else {
		result.Status = "fail"
		result.Message = "Last user name is displayed at logon"
	}
	return result
}

// checkUACLocalAccountFilter validates CIS 18.4.1 — LocalAccountTokenFilterPolicy.
func checkUACLocalAccountFilter() CheckResult {
	result := CheckResult{
		CheckID:  "18.4.1",
		Title:    "Ensure 'Apply UAC restrictions to local accounts on network logons' is set to 'Enabled'",
		Severity: "high",
	}

	output, err := security.RunCommand(8*time.Second,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'LocalAccountTokenFilterPolicy' -ErrorAction SilentlyContinue).LocalAccountTokenFilterPolicy")
	if err != nil {
		// If the key doesn't exist, the default is to apply UAC restrictions (pass).
		result.Status = "pass"
		result.Message = "LocalAccountTokenFilterPolicy not set (default: UAC applied)"
		result.Evidence = map[string]any{"localAccountTokenFilterPolicy": "not_set"}
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"localAccountTokenFilterPolicy": val}

	if val == "0" || val == "" {
		result.Status = "pass"
		result.Message = "UAC restrictions are applied to local accounts on network logons"
	} else {
		result.Status = "fail"
		result.Message = "UAC restrictions are NOT applied to local accounts on network logons"
	}
	return result
}

// checkRegistryPolicyProcessing validates CIS 18.9.4.
func checkRegistryPolicyProcessing() CheckResult {
	result := CheckResult{
		CheckID:  "18.9.4",
		Title:    "Ensure 'Configure registry policy processing' processes even if GPOs have not changed",
		Severity: "medium",
	}

	output, err := security.RunCommand(8*time.Second,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Group Policy\\{35378EAC-683F-11D2-A89A-00C04FBBCFA2}' -Name 'NoGPOListChanges' -ErrorAction SilentlyContinue).NoGPOListChanges")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to read registry: %s", err.Error())
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"noGPOListChanges": val}

	if val == "0" {
		result.Status = "pass"
		result.Message = "Registry policy processing is configured to process even if GPOs have not changed"
	} else {
		result.Status = "fail"
		result.Message = "Registry policy processing skips unchanged GPOs"
	}
	return result
}

// checkAuditCredentialValidation validates CIS 17.1.1.
func checkAuditCredentialValidation() CheckResult {
	result := CheckResult{
		CheckID:  "17.1.1",
		Title:    "Ensure 'Audit Credential Validation' is set to 'Success and Failure'",
		Severity: "medium",
	}

	output, err := security.RunCommand(10*time.Second,
		"auditpol", "/get", "/subcategory:Credential Validation")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to query audit policy: %s", err.Error())
		return result
	}

	lower := strings.ToLower(output)
	result.Evidence = map[string]any{"auditpolOutput": output}

	if strings.Contains(lower, "success and failure") {
		result.Status = "pass"
		result.Message = "Audit Credential Validation is set to Success and Failure"
	} else {
		result.Status = "fail"
		result.Message = "Audit Credential Validation is not set to Success and Failure"
	}
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
