//go:build windows

package cis

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

func platformRemediate(checkID, action string, payload map[string]any) RemediationResult {
	switch checkID {
	case "1.1.1":
		return remediatePasswordHistory()
	case "2.3.1":
		return remediateGuestAccount()
	case "9.1.1":
		return remediateFirewall()
	default:
		return RemediationResult{
			CheckID: checkID,
			Action:  action,
			Success: false,
			Error:   fmt.Sprintf("no Windows remediation implemented for check %s", checkID),
		}
	}
}

// remediatePasswordHistory sets password history to 24.
func remediatePasswordHistory() RemediationResult {
	result := RemediationResult{
		CheckID: "1.1.1",
		Action:  "set_local_password_policy",
	}

	// Capture before state.
	policy, _ := security.CollectPasswordPolicySummary()
	if policy != nil {
		result.BeforeState = map[string]any{"historyCount": policy["historyCount"]}
	}

	_, err := security.RunCommand(10*time.Second, "net", "accounts", "/uniquepw:24")
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("failed to set password history: %s", err.Error())
		return result
	}

	// Capture after state.
	policy, _ = security.CollectPasswordPolicySummary()
	if policy != nil {
		result.AfterState = map[string]any{"historyCount": policy["historyCount"]}
	}

	result.Success = true
	result.RollbackHint = "net accounts /uniquepw:<previous_value>"
	return result
}

// remediateGuestAccount disables the guest account.
func remediateGuestAccount() RemediationResult {
	result := RemediationResult{
		CheckID: "2.3.1",
		Action:  "disable_local_account",
	}

	// Capture before state.
	out, _ := security.RunCommand(8*time.Second,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-LocalUser -Name Guest).Enabled")
	result.BeforeState = map[string]any{"guestEnabled": out}

	_, err := security.RunCommand(10*time.Second, "net", "user", "guest", "/active:no")
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("failed to disable guest account: %s", err.Error())
		return result
	}

	// Capture after state.
	out, _ = security.RunCommand(8*time.Second,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-LocalUser -Name Guest).Enabled")
	result.AfterState = map[string]any{"guestEnabled": out}

	result.Success = true
	result.RollbackHint = "net user guest /active:yes"
	return result
}

// remediateFirewall enables Windows Firewall for all profiles.
func remediateFirewall() RemediationResult {
	result := RemediationResult{
		CheckID: "9.1.1",
		Action:  "set_firewall_state",
	}

	// Capture before state.
	enabled, _ := security.GetFirewallStatus()
	result.BeforeState = map[string]any{"firewallEnabled": enabled}

	_, err := security.RunCommand(10*time.Second, "netsh", "advfirewall", "set", "allprofiles", "state", "on")
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("failed to enable firewall: %s", err.Error())
		return result
	}

	// Capture after state.
	enabled, _ = security.GetFirewallStatus()
	result.AfterState = map[string]any{"firewallEnabled": enabled}

	result.Success = true
	result.RollbackHint = "netsh advfirewall set allprofiles state off"
	return result
}
