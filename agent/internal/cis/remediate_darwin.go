//go:build darwin

package cis

import "fmt"

func platformRemediate(checkID, action string, payload map[string]any) RemediationResult {
	return RemediationResult{
		CheckID: checkID,
		Action:  action,
		Success: false,
		Error:   fmt.Sprintf("macOS CIS remediation not yet implemented (check %s)", checkID),
	}
}
