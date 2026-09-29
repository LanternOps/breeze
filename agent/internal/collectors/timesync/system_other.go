//go:build !windows

package timesync

func NewSystem() System { return nil }
