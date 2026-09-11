//go:build !linux

package rebuild

// NewSystem is unavailable off Linux in this wave (Windows engine is W06).
func NewSystem() System { return nil }
