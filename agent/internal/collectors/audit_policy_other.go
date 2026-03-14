//go:build !windows && !linux && !darwin

package collectors

import "errors"

func collectAuditPolicyState() (AuditPolicySnapshot, error) {
	return AuditPolicySnapshot{
		OSType:      "unknown",
		CollectedAt: nowRFC3339(),
		Settings:    map[string]any{},
		Raw:         map[string]any{},
	}, errors.New("audit policy collection is not supported on this OS")
}

func applyAuditPolicyBaseline(_ map[string]any) (AuditPolicyApplyResult, error) {
	return AuditPolicyApplyResult{
		AppliedAt: nowRFC3339(),
		Applied:   0,
		Skipped:   0,
		Errors:    []string{"audit baseline apply is not supported on this OS"},
	}, errors.New("audit baseline apply is not supported on this OS")
}
