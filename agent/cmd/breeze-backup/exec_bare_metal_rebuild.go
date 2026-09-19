package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// bareMetalRebuildTimeout bounds one server-driven rebuild (W05a): a full
// whole-machine restore plus a VHDX conversion on a slow host. The server's
// own command timeout (RESTORE_TIMEOUT_TYPES) is the outer bound.
const bareMetalRebuildTimeout = 4 * time.Hour

// bareMetalRebuildPayload is the bare_metal_rebuild command payload
// (apps/api/src/services/bareMetalRebuildCommand.ts
// bareMetalRebuildPayloadSchema). The token is a server-minted recovery
// token, never the 9-character code. Identity is informational only: the
// helper takes it from the bootstrap's recovery binding (server-enforced),
// exactly as `breeze-backup rebuild --token` does.
type bareMetalRebuildPayload struct {
	RecoveryID string `json:"recoveryId"`
	Token      string `json:"token"`
	Server     string `json:"server"`
	Target     struct {
		Kind           string `json:"kind"` // vhdx | image
		Path           string `json:"path"`
		ImageSizeBytes int64  `json:"imageSizeBytes,omitempty"`
	} `json:"target"`
	Identity  string `json:"identity,omitempty"`
	OutputDir string `json:"outputDir,omitempty"`
}

func (p *bareMetalRebuildPayload) validate() error {
	switch {
	case p.RecoveryID == "":
		return errors.New("recoveryId is required")
	case p.Token == "" || p.Server == "":
		return errors.New("token and server are required")
	case p.Target.Kind != string(rebuild.TargetVHDX) && p.Target.Kind != string(rebuild.TargetImage):
		return fmt.Errorf("target.kind must be vhdx or image, got %q", p.Target.Kind)
	case p.Target.Path == "" || !filepath.IsAbs(p.Target.Path):
		return fmt.Errorf("target.path must be an absolute path, got %q", p.Target.Path)
	}
	return nil
}

// bareMetalRebuildResult is the command result body: the engine Result
// verbatim plus the recovery it belonged to, so the server can reconcile
// the row even when the helper's progress posts never reached it.
type bareMetalRebuildResult struct {
	*rebuild.Result
	RecoveryID string `json:"recoveryId"`
}

// execBareMetalRebuild executes a server-driven bare_metal_rebuild command
// on this host through the same token-mode path as `breeze-backup rebuild
// --token`: authenticate the recovery token, build the options from the
// bootstrap, dry-run preflight, run, and post exactly one terminal
// progress status (validated/refused/failed). rebuildFn is rebuild.Run
// outside tests.
//
// Outcome mapping: a completed run is a successful command carrying the
// result; a REFUSED run is also a successful command (the result's status
// says "refused" — the server maps it, the helper did its job); a failed
// run is a failed command whose Stderr is the reason and whose Stdout still
// carries the result body (phases reached, warnings) for diagnosis; an
// unsupported host fails with rebuild.ErrUnsupportedHost's text verbatim.
func execBareMetalRebuild(parentCtx context.Context, payload json.RawMessage, rebuildFn func(context.Context, rebuild.Options) (*rebuild.Result, error)) backupipc.BackupCommandResult {
	var p bareMetalRebuildPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid bare_metal_rebuild payload: " + err.Error())
	}
	if err := p.validate(); err != nil {
		return fail("invalid bare_metal_rebuild payload: " + err.Error())
	}

	ctx, cancel := context.WithTimeout(parentCtx, bareMetalRebuildTimeout)
	defer cancel()

	target := rebuild.Target{Kind: rebuild.TargetKind(p.Target.Kind), Path: p.Target.Path, ImageSizeBytes: p.Target.ImageSizeBytes}
	opts, report, err := buildTokenModeOptions(ctx, p.Server, p.Token, target, "")
	if err != nil {
		return fail(err.Error())
	}
	opts.RegenerateInitramfs = true // the CLI's default; a direct Options caller must ask for it explicitly
	opts.System = rebuildSystemForTest
	opts.Progress = func(ph rebuild.Phase, msg string, cur, total int64) {
		slog.Info("bare_metal_rebuild progress", "recoveryId", p.RecoveryID, "phase", string(ph), "message", msg, "current", cur, "total", total)
	}

	res, runErr := runTokenModeRebuild(ctx, opts, report, rebuildFn)
	if errors.Is(runErr, rebuild.ErrUnsupportedHost) {
		return fail(rebuild.ErrUnsupportedHost.Error())
	}
	if res == nil {
		if runErr == nil {
			runErr = errors.New("rebuild returned no result")
		}
		return fail(runErr.Error())
	}
	body, merr := json.Marshal(bareMetalRebuildResult{Result: res, RecoveryID: p.RecoveryID})
	if merr != nil {
		return fail(fmt.Sprintf("failed to marshal result: %v", merr))
	}
	if runErr != nil && res.Status != "refused" {
		reason := runErr.Error()
		if res.Error != "" {
			reason = res.Error
		}
		return backupipc.BackupCommandResult{Success: false, Stdout: string(body), Stderr: reason}
	}
	return ok(string(body))
}
