package tools

import (
	"context"
	"strings"

	"github.com/breeze-rmm/agent/internal/systemrestore"
)

// createRestorePoint is the checkpoint attempt itself. A var solely so tests
// can count attempts and assert ordering without touching System Restore.
// (tools cannot import heartbeat, which owns the equivalent seam for patches
// and scripts.)
var createRestorePoint systemrestore.CreateFunc = systemrestore.Create

// newSoftwareCheckpoint builds the at-most-one restore-point checkpoint for a
// software_install command (#4609 W07). A missing block means disabled.
func newSoftwareCheckpoint(payload map[string]any) *systemrestore.Checkpoint {
	label := "install software"
	if name := strings.TrimSpace(GetPayloadString(payload, "softwareName", "")); name != "" {
		label = "install " + name
	}
	return systemrestore.NewCheckpoint(payload, false, label, createRestorePoint)
}

// takeSoftwareCheckpoint takes cp immediately before the install's first
// mutation, under its own systemrestore.CommandBudget so it never shortens
// the installer's timeout. Callers attach cp.Report() on every return path.
func takeSoftwareCheckpoint(cp *systemrestore.Checkpoint) {
	if !cp.Requested() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), systemrestore.CommandBudget)
	defer cancel()
	cp.Take(ctx)
}
