package collectors

import (
	"context"
	"time"
)

// RunCollectorOutput shares the collector command limits with subpackages.
func RunCollectorOutput(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	return runCollectorOutputWithContext(ctx, timeout, name, args...)
}
