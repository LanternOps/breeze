//go:build !windows

package wakeconfig

// NewWriter returns nil off Windows: there is nothing to write.
func NewWriter() Writer { return nil }
