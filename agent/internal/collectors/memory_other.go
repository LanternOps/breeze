//go:build !windows && !linux && !darwin

package collectors

func collectPlatformMemory() (*MemoryInfo, error) { return nil, ErrMemoryUnsupported }
