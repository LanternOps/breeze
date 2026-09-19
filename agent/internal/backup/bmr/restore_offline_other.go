//go:build !linux

package bmr

import (
	"context"
	"errors"
)

// RestoreSystemStateOffline is Linux-only in this release — the rebuild
// engine itself (agent/internal/backup/rebuild) only ever runs on Linux
// hosts, so this stub exists purely so the bmr package still builds (and its
// cross-platform test doubles still compile) on darwin/windows.
func RestoreSystemStateOffline(_ context.Context, _, _ string) ([]string, error) {
	return nil, errors.New("offline system-state apply is Linux-only in this release")
}
