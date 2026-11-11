package main

import (
	"context"
	"fmt"
	"io"
	"os"
)

type recoveryManager interface {
	RecoveryExpireCheck(context.Context) error
	BootApply(context.Context) error
	RollbackIfUncommitted(context.Context, string) error
	ReleaseAll(context.Context, string) error
}

type recoveryDependencies struct {
	manager  func(dataDir string) (recoveryManager, error)
	selfTest func(context.Context) error
}

// recoverySelfTest only inspects the engine and opens/reads the state directory.
// It creates neither a lock file, a journal, tasks nor filters; feature activation
// is an agent apply gate and has no bearing on this executable's ability to run.
func recoverySelfTest(ctx context.Context, engine interface {
	Owned(context.Context) (bool, error)
}, dataDir string) error {
	if _, err := engine.Owned(ctx); err != nil {
		return fmt.Errorf("recovery engine unavailable: %w", err)
	}
	dir, err := os.Open(dataDir)
	if err != nil {
		return fmt.Errorf("read recovery state directory: %w", err)
	}
	defer func() { _ = dir.Close() }()
	if _, err = dir.Readdirnames(1); err != nil && err != io.EOF {
		return fmt.Errorf("read recovery state directory: %w", err)
	}
	return nil
}
