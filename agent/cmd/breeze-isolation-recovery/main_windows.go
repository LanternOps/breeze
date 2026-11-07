//go:build windows

package main

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/isolation"
	"golang.org/x/sys/windows"
)

func platformRecoveryDependencies() recoveryDependencies {
	return recoveryDependencies{
		manager: func(dataDir string) (recoveryManager, error) {
			return isolation.NewManager(isolation.ManagerDeps{DataDir: dataDir, Isolator: isolation.NewPlatformIsolator(), Scheduler: isolation.NewPlatformScheduler(dataDir)}), nil
		},
		selfTest: func(ctx context.Context) error {
			programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
			if err != nil {
				return fmt.Errorf("locate recovery state directory: %w", err)
			}
			return recoverySelfTest(ctx, isolation.NewPlatformIsolator(), filepath.Join(programData, "Breeze", "data"))
		},
	}
}
