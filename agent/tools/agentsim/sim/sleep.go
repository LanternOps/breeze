package sim

import (
	"context"
	"time"
)

// sleepCtx waits d or until ctx ends; false means ctx ended.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func osVersion(osType string) string {
	switch osType {
	case "windows":
		return "Windows 11 Pro 23H2 (agentsim)"
	case "macos":
		return "macOS 15.1 (agentsim)"
	default:
		return "Ubuntu 24.04 LTS (agentsim)"
	}
}
