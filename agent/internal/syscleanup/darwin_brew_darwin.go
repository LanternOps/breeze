//go:build darwin

package syscleanup

import (
	"context"

	"github.com/breeze-rmm/agent/internal/patching"
)

// brewCleanupRun delegates to patching's BOUNDED, UNLOCKED entry point.
//
// Unlocked on purpose: `syscleanup.Run` already holds the process-wide
// maintenance lock for the whole run (spec §13 #4/#12), so calling
// `patching.BrewCleanup` — which acquires it — would deadlock against
// ourselves. `RunBrewCleanupBounded` is the same invocation both callers use;
// only the locking level differs.
//
// Delegating rather than reimplementing is the point: the console-user
// `sudo -n -H -u` dance Homebrew requires when the agent runs as root lives in
// `patching.brewCommand`, and there is exactly one brew invocation path in the
// agent.
func brewCleanupRun(ctx context.Context, dryRun bool) (string, error) {
	return patching.RunBrewCleanupBounded(ctx, dryRun)
}
