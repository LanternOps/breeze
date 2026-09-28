package hyperv

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

// psWaitDelay bounds how long a killed command's output pipes may stay open
// (held by a grandchild) before Wait gives up on them, so a cancelled or timed
// out run always returns.
const psWaitDelay = 5 * time.Second

// runCmdContext runs name with args under ctx, bounded by timeout (0 = ctx
// only), and returns the combined output. It is the process half of
// runPSContext (discovery.go), kept platform-neutral so its cancellation and
// timeout behaviour is tested on every OS.
func runCmdContext(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	if ctx.Err() != nil {
		return "", fmt.Errorf("%s not started: %w", name, context.Cause(ctx))
	}
	runCtx, cancel := ctx, context.CancelFunc(func() {})
	if timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, timeout)
	}
	defer cancel()

	cmd := exec.CommandContext(runCtx, name, args...)
	cmd.WaitDelay = psWaitDelay
	out, err := cmd.CombinedOutput()
	switch {
	case ctx.Err() != nil:
		return "", fmt.Errorf("%s canceled: %w: %s", name, context.Cause(ctx), out)
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		return "", fmt.Errorf("%s timed out after %s: %s", name, timeout, out)
	case err != nil:
		return "", fmt.Errorf("%s failed: %w: %s", name, err, out)
	}
	return string(out), nil
}
