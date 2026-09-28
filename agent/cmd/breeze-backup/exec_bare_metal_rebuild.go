package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

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
	Identity  string         `json:"identity,omitempty"`
	OutputDir string         `json:"outputDir,omitempty"`
	HyperV    *hyperVPayload `json:"hyperv,omitempty"`
}

// hyperVPayload mirrors apps/api/src/services/bareMetalRebuildSchemas.ts
// hypervOptionsSchema field-for-field. When set, the helper creates a Hyper-V
// VM from the rebuilt VHDX after a completed run (no NIC unless switchName).
type hyperVPayload struct {
	VMName     string `json:"vmName"`
	SwitchName string `json:"switchName,omitempty"`
	MemoryMB   int64  `json:"memoryMb,omitempty"`
	CPUCount   int    `json:"cpuCount,omitempty"`
}

// hostGOOS is runtime.GOOS; a var so tests exercise the Windows-only hyperv
// path on the Linux/macOS CI agents.
var hostGOOS = runtime.GOOS

// createRebuildVMFn is the Hyper-V VM-create seam (hyperv.CreateVMFromVHDX
// on Windows); overridden in tests. Distinct from execBareMetalRebuild's
// rebuildFn parameter, which is the rebuild ENGINE (rebuild.Run).
var createRebuildVMFn = createRebuildVM

// createVMRequest is the VM-create request for this payload: the VM boots the
// VHDX the helper told the engine to write (target.path, validated here).
func (p *bareMetalRebuildPayload) createVMRequest() hyperv.CreateVMRequest {
	return hyperv.CreateVMRequest{
		VMName:     p.HyperV.VMName,
		VHDXPath:   p.Target.Path,
		SwitchName: p.HyperV.SwitchName,
		MemoryMB:   p.HyperV.MemoryMB,
		CPUCount:   p.HyperV.CPUCount,
	}
}

func (p *bareMetalRebuildPayload) validate() error {
	switch {
	case p.RecoveryID == "":
		return errors.New("recoveryId is required")
	case p.Token == "" || p.Server == "":
		return errors.New("token and server are required")
	case p.Target.Kind != string(rebuild.TargetVHDX) && p.Target.Kind != string(rebuild.TargetImage):
		return fmt.Errorf("target.kind must be vhdx or image, got %q", p.Target.Kind)
	case strings.HasPrefix(p.Target.Path, `\\`) || (hostGOOS == "windows" && strings.HasPrefix(p.Target.Path, "//")):
		// The API refuses UNC (isAbsoluteRebuildPath); filepath.IsAbs on
		// Windows would accept \\server\share\x, so refuse it here too.
		return fmt.Errorf("target.path must be a local absolute path, not a UNC path: %q", p.Target.Path)
	case p.Target.Path == "" || !filepath.IsAbs(p.Target.Path):
		return fmt.Errorf("target.path must be an absolute path, got %q", p.Target.Path)
	}
	if p.HyperV == nil {
		return nil
	}
	if hostGOOS != "windows" {
		return errors.New("hyperv is only supported on Windows hosts")
	}
	if p.Target.Kind != string(rebuild.TargetVHDX) {
		return fmt.Errorf("hyperv requires target.kind vhdx, got %q", p.Target.Kind)
	}
	return hyperv.ValidateCreateVMRequest(p.createVMRequest())
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
// bootstrap, dry-run preflight, run, create the optional Hyper-V VM, and
// post exactly one terminal progress status (validated/refused/failed).
// rebuildFn is rebuild.Run outside tests.
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

	// No fixed deadline (#6664): the watchdog stops a rebuild that stops
	// making progress, with an absolute ceiling as a backstop. See
	// rebuild_budget.go.
	ctx, watchdog, stop := startRebuildWatchdog(parentCtx, bareMetalRebuildBudget)
	defer stop()

	target := rebuild.Target{Kind: rebuild.TargetKind(p.Target.Kind), Path: p.Target.Path, ImageSizeBytes: p.Target.ImageSizeBytes}
	opts, report, err := buildTokenModeOptions(ctx, p.Server, p.Token, target, "")
	if err != nil {
		return fail(err.Error())
	}
	opts.RegenerateInitramfs = true // the CLI's default; a direct Options caller must ask for it explicitly
	opts.System = rebuildSystemForTest
	opts.WinSystem = rebuildWinSystemForTest
	opts.Progress = func(ph rebuild.Phase, msg string, cur, total int64) {
		watchdog.progress(ph)
		slog.Info("bare_metal_rebuild progress", "recoveryId", p.RecoveryID, "phase", string(ph), "message", msg, "current", cur, "total", total)
	}

	// The optional Hyper-V VM is created inside the token-mode run, after
	// the engine completes and before the "validated" post, so that post
	// carries vmCreated/vmError to the recovery row (see runTokenModeRebuild).
	var afterRun func(context.Context, *rebuild.Result)
	if p.HyperV != nil {
		afterRun = func(ctx context.Context, res *rebuild.Result) {
			if res.Status == "completed" {
				createHyperVVM(ctx, &p, res)
			}
		}
	}

	res, runErr := runTokenModeRebuild(ctx, opts, report, rebuildFn, afterRun)
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

// createHyperVVM creates the optional Hyper-V VM after a completed rebuild
// (before the validated progress post — see execBareMetalRebuild) and records
// the outcome on res. A failure never fails the command — the
// rebuild succeeded and the VHDX stays where it is — but it is never silent
// either: VMCreated stays false, VMError carries the reason, and the reason
// leads Warnings so no warning cap can trim it away.
func createHyperVVM(ctx context.Context, p *bareMetalRebuildPayload, res *rebuild.Result) {
	req := p.createVMRequest()
	if err := createRebuildVMFn(ctx, req); err != nil {
		slog.Warn("bare_metal_rebuild: hyperv VM creation failed", "recoveryId", p.RecoveryID, "vmName", req.VMName, "error", err.Error())
		res.VMError = err.Error()
		res.Warnings = append([]string{"hyperv VM creation failed: " + err.Error()}, res.Warnings...)
		return
	}
	slog.Info("bare_metal_rebuild: hyperv VM created", "recoveryId", p.RecoveryID, "vmName", req.VMName)
	res.VMCreated = true
}
