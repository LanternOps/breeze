package mgmtdetect

// AllSignatures returns the complete signature database for management tool detection.
// TODO: populate with actual signatures in a subsequent task.
func AllSignatures() []Signature {
	return []Signature{
		{
			Name:     "Example RMM",
			Category: CategoryRMM,
			OS:       []string{"windows", "darwin", "linux"},
			Checks: []Check{
				{Type: CheckProcessRunning, Value: "example-rmm-agent"},
			},
		},
	}
}
