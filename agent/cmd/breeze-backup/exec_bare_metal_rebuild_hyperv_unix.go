//go:build !windows

package main

import (
	"context"
	"errors"

	"github.com/breeze-rmm/agent/internal/backup/hyperv"
)

// createRebuildVM is unreachable off Windows (validate refuses hyperv first);
// it refuses rather than pretending.
func createRebuildVM(context.Context, hyperv.CreateVMRequest) error {
	return errors.New("hyperv VM creation is only supported on Windows hosts")
}
