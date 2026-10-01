//go:build !windows

package timesync

func NewWriter() Writer { return nil }
