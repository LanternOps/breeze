package backup

import (
	"context"
	"time"
)

type executionGuardKey struct{}

var executionGuard = make(chan struct{}, 1)

// AcquireExecution serializes backup workloads across manager instances. Passing
// the returned context into RunBackupContext shares ownership without deadlock.
func AcquireExecution(ctx context.Context) (context.Context, func(), error) {
	return AcquireExecutionWithProgress(ctx, nil)
}

// AcquireExecutionWithProgress reports liveness while waiting for another workload.
func AcquireExecutionWithProgress(ctx context.Context, waiting func()) (context.Context, func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Value(executionGuardKey{}) != nil {
		return ctx, func() {}, nil
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case executionGuard <- struct{}{}:
			if err := ctx.Err(); err != nil {
				<-executionGuard
				return ctx, nil, err
			}
			return context.WithValue(ctx, executionGuardKey{}, true), func() { <-executionGuard }, nil
		case <-ticker.C:
			if waiting != nil {
				waiting()
			}
		case <-ctx.Done():
			return ctx, nil, ctx.Err()
		}
	}
}
