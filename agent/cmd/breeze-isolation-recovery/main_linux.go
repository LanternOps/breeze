//go:build linux

package main

import (
	"context"

	"github.com/breeze-rmm/agent/internal/isolation"
)

// linuxDataDir is config.GetDataDir() on Linux; this binary must not link the
// config package. The units pass --data-dir explicitly; only self-test takes
// no arguments.
const linuxDataDir = "/var/lib/breeze"

func platformRecoveryDependencies() recoveryDependencies {
	return recoveryDependencies{
		manager: func(dataDir string) (recoveryManager, error) {
			return linuxRecoveryManager{isolation.NewManager(isolation.ManagerDeps{
				DataDir:   dataDir,
				Isolator:  isolation.NewPlatformIsolator(),
				Scheduler: isolation.NewPlatformScheduler(dataDir),
			})}, nil
		},
		selfTest: func(ctx context.Context) error {
			return recoverySelfTest(ctx, isolation.NewPlatformIsolator(), linuxDataDir)
		},
	}
}

// linuxRecoveryManager adds what a reboot takes away: nft rules live only in
// the kernel, so boot-apply also restores a still-valid committed episode.
type linuxRecoveryManager struct{ *isolation.Manager }

func (m linuxRecoveryManager) BootApply(ctx context.Context) error {
	return m.BootApplyAndRestore(ctx)
}
