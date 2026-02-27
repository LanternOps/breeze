package collectors

import "time"

// AuditPolicySnapshot captures current endpoint audit-policy settings.
type AuditPolicySnapshot struct {
	OSType      string         `json:"osType"`
	CollectedAt string         `json:"collectedAt"`
	Settings    map[string]any `json:"settings"`
	Raw         map[string]any `json:"raw,omitempty"`
}

// AuditPolicyApplyResult reports what baseline settings were applied.
type AuditPolicyApplyResult struct {
	Applied   int      `json:"applied"`
	Skipped   int      `json:"skipped"`
	Errors    []string `json:"errors,omitempty"`
	AppliedAt string   `json:"appliedAt"`
}

func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// CollectAuditPolicyState gathers OS audit-policy state for compliance evaluation.
// Platform-specific implementations are selected via build tags (_windows, _linux, _darwin).
func CollectAuditPolicyState() (AuditPolicySnapshot, error) {
	return collectAuditPolicyState()
}

// ApplyAuditPolicyBaseline applies supported audit-policy settings on the endpoint.
// Platform-specific implementations are selected via build tags (_windows, _linux, _darwin).
func ApplyAuditPolicyBaseline(settings map[string]any) (AuditPolicyApplyResult, error) {
	return applyAuditPolicyBaseline(settings)
}
