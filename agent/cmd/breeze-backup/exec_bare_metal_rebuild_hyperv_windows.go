//go:build windows

package main

import (
	"context"

	"github.com/breeze-rmm/agent/internal/backup/hyperv"
)

func createRebuildVM(ctx context.Context, req hyperv.CreateVMRequest) error {
	return hyperv.CreateVMFromVHDX(ctx, req)
}
