//go:build !windows

package oemupdates

import (
	"context"
	"errors"

	"github.com/breeze-rmm/agent/internal/patching"
)

var errSurfaceWindowsOnly = errors.New("the Surface lane only runs on windows")

// systemSurfaceHost off Windows answers nothing: the handler refuses before any
// lane runs, and these keep a stray call failing closed.
func systemSurfaceHost() surfaceHost {
	return surfaceHost{
		identity:        func() (string, string, error) { return "", "", errSurfaceWindowsOnly },
		updatesDisabled: func() bool { return true },
		search: func(context.Context) ([]patching.DriverUpdate, error) {
			return nil, errSurfaceWindowsOnly
		},
		install: func(_ context.Context, ids []string) []patching.DriverInstallOutcome {
			out := make([]patching.DriverInstallOutcome, 0, len(ids))
			for _, id := range ids {
				out = append(out, patching.DriverInstallOutcome{UpdateID: id, Err: errSurfaceWindowsOnly})
			}
			return out
		},
		rebootPending: detectPendingReboot,
		power:         systemPower{}.Status,
		guard:         ProductionGuardDeps(),
	}
}
