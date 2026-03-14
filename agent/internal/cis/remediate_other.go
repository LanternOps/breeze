//go:build !windows && !linux && !darwin

package cis

import (
	"fmt"
	"runtime"
)

func platformRemediate(checkID, action string, payload map[string]any) RemediationResult {
	return RemediationResult{
		CheckID: checkID,
		Action:  action,
		Success: false,
		Error:   fmt.Sprintf("CIS remediation not supported on %s", runtime.GOOS),
	}
}
