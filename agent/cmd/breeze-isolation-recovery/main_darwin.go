//go:build darwin

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/breeze-rmm/agent/internal/isolation"
)

// darwinRecoveryOps are the macOS forms of the recovery operations (see
// internal/isolation/recovery_darwin.go): launchd runs one command line at load
// and on every interval, and has no seconds-precision one-shot, so boot-apply
// and the rollback job must judge each attempt by its own deadline and boot.
type darwinRecoveryOps interface {
	RecoveryExpireCheck(context.Context) error
	DarwinBootApply(context.Context) error
	DarwinRollbackIfOverdue(context.Context, string) error
	ReleaseAll(context.Context, string) error
}

type darwinRecoveryManager struct{ ops darwinRecoveryOps }

func (m darwinRecoveryManager) RecoveryExpireCheck(ctx context.Context) error {
	return m.ops.RecoveryExpireCheck(ctx)
}
func (m darwinRecoveryManager) BootApply(ctx context.Context) error {
	return m.ops.DarwinBootApply(ctx)
}
func (m darwinRecoveryManager) RollbackIfUncommitted(ctx context.Context, attempt string) error {
	return m.ops.DarwinRollbackIfOverdue(ctx, attempt)
}
func (m darwinRecoveryManager) ReleaseAll(ctx context.Context, reason string) error {
	return m.ops.ReleaseAll(ctx, reason)
}

func darwinRecoveryDependencies(newOps func(dataDir string) darwinRecoveryOps, selfTest func(context.Context) error) recoveryDependencies {
	return recoveryDependencies{
		manager: func(dataDir string) (recoveryManager, error) {
			return darwinRecoveryManager{ops: newOps(dataDir)}, nil
		},
		selfTest: selfTest,
	}
}

func platformRecoveryDependencies() recoveryDependencies {
	return darwinRecoveryDependencies(func(dataDir string) darwinRecoveryOps {
		finishWhenLaunchdStopsTheJob()
		return isolation.NewManager(isolation.ManagerDeps{DataDir: dataDir, Isolator: isolation.NewPlatformIsolator(), Scheduler: isolation.NewPlatformScheduler(dataDir)})
	}, func(ctx context.Context) error {
		return recoverySelfTest(ctx, isolation.NewPlatformIsolator(), isolation.DarwinDataDir)
	})
}

// finishWhenLaunchdStopsTheJob: when an episode ends, this job removes its own
// LaunchDaemon, and launchd answers with SIGTERM while the remaining steps are
// still running. Every transition is journalled before its effects, so dying
// would be safe, but finishing is cleaner: the signal is received and dropped,
// the run ends normally, and launchd's exit timeout (SIGKILL) still bounds it.
// A handler, unlike ignoring the signal, is not inherited by pfctl or launchctl.
func finishWhenLaunchdStopsTheJob() {
	signal.Notify(make(chan os.Signal, 1), syscall.SIGTERM)
}
