//go:build !windows

package main

import (
	"context"
	"fmt"

	"github.com/breeze-rmm/agent/internal/isolation"
)

func platformRecoveryDependencies() recoveryDependencies {
	return recoveryDependencies{
		manager: func(string) (recoveryManager, error) {
			return nil, fmt.Errorf("unsupported platform: %w", isolation.ErrUnsupported)
		},
		selfTest: func(context.Context) error {
			return fmt.Errorf("unsupported platform: %s", isolation.NewPlatformIsolator().Capability().UnsupportedReason)
		},
	}
}
