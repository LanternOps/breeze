//go:build !windows && !linux && !darwin

package cis

import "runtime"

func platformChecks() []Check {
	return []Check{
		{
			ID:       "0.0.0",
			Title:    "CIS benchmark not supported on this OS",
			Severity: "low",
			Level:    "l1",
			Fn: func() CheckResult {
				return CheckResult{
					CheckID:  "0.0.0",
					Title:    "CIS benchmark not supported on this OS",
					Severity: "low",
					Status:   "error",
					Message:  "CIS benchmark checks are not supported on " + runtime.GOOS,
				}
			},
		},
	}
}
