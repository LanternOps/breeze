package heartbeat

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
)

func init() {
	handlerRegistry[tools.CmdSecurityCollectStatus] = handleSecurityCollectStatus
	handlerRegistry[tools.CmdSecurityScan] = handleSecurityScan
	handlerRegistry[tools.CmdSecurityThreatQuarantine] = handleSecurityThreatQuarantine
	handlerRegistry[tools.CmdSecurityThreatRemove] = handleSecurityThreatRemove
	handlerRegistry[tools.CmdSecurityThreatRestore] = handleSecurityThreatRestore
	handlerRegistry[tools.CmdSensitiveDataScan] = handleSensitiveDataScan
	handlerRegistry[tools.CmdEncryptFile] = handleEncryptFile
	handlerRegistry[tools.CmdSecureDeleteFile] = handleSecureDeleteFile
	handlerRegistry[tools.CmdQuarantineFile] = handleQuarantineFile
}

func handleSecurityCollectStatus(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	status, err := security.CollectStatus(h.config)
	if err != nil {
		return tools.NewSuccessResult(map[string]any{
			"status":  status,
			"warning": err.Error(),
		}, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(status, time.Since(start).Milliseconds())
}

func handleSecurityScan(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	cmdLog := log.With("commandId", cmd.ID, "commandType", cmd.Type)

	scanType := strings.ToLower(tools.GetPayloadString(cmd.Payload, "scanType", "quick"))
	scanRecordID := tools.GetPayloadString(cmd.Payload, "scanRecordId", "")
	paths := tools.GetPayloadStringSlice(cmd.Payload, "paths")

	// #6263 W01 — settings resolved from the device's effective security
	// config policy and delivered per scan in the command payload. Every key
	// is optional on the wire: an agent from before this wave, or a scan
	// dispatched with no policy behind it, sees none of these and the
	// scanner's zero values (agent defaults) apply.
	exclusions := tools.GetPayloadStringSlice(cmd.Payload, "exclusions")
	maxFileSizeMb := tools.GetPayloadInt(cmd.Payload, "maxFileSizeMb", 0)
	timeoutMinutes := tools.GetPayloadInt(cmd.Payload, "timeoutMinutes", 0)
	autoQuarantine := tools.GetPayloadBool(cmd.Payload, "autoQuarantine", false)

	if scanType != "quick" && scanType != "full" && scanType != "custom" {
		return tools.NewErrorResult(fmt.Errorf("unsupported scanType: %s", scanType), time.Since(start).Milliseconds())
	}
	if scanType == "custom" && len(paths) == 0 {
		return tools.NewErrorResult(fmt.Errorf("custom scan requires one or more paths"), time.Since(start).Milliseconds())
	}

	scanner := *h.securityScanner // shallow copy: per-scan settings never mutate the shared scanner
	scanner.Exclusions = exclusions
	scanner.AutoQuarantine = autoQuarantine
	if maxFileSizeMb > 0 {
		scanner.MaxFileSize = int64(maxFileSizeMb) << 20
	}
	if timeoutMinutes > 0 {
		scanner.Timeout = time.Duration(timeoutMinutes) * time.Minute
	}

	outcome, err := scanner.ScanWithContext(context.Background(), scanType, paths)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	if runtime.GOOS == "windows" && tools.GetPayloadBool(cmd.Payload, "triggerDefender", false) && scanType != "custom" {
		if defErr := security.TriggerDefenderScan(scanType); defErr != nil {
			cmdLog.Warn("defender scan trigger warning", "error", defErr)
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"scanRecordId": scanRecordID,
		"scanType":     scanType,
		"durationMs":   outcome.Duration.Milliseconds(),
		"threatsFound": len(outcome.Threats),
		"threats":      outcome.Threats,
		"status":       outcome.Status,
		"filesScanned": outcome.FilesScanned,
		"timedOut":     outcome.TimedOut,
		"partial":      outcome.Partial,
	}, time.Since(start).Milliseconds())
}

func handleSecurityThreatQuarantine(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	path, errResult := tools.RequirePayloadString(cmd.Payload, "path")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	// Containment (#3397): threat quarantine is an os.Rename into a
	// caller-chosen directory — the same laundering primitive as
	// tools.QuarantineFile, just reached through the threat surface instead of
	// the file browser. Gated here rather than inside internal/security so that
	// package keeps no dependency on the tools deny-list.
	// Check and use the same string, as every other call site in #3397 does.
	path = filepath.Clean(path)
	if err := tools.EnforcePathContainment("quarantine", path); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	quarantineDir := tools.GetPayloadString(cmd.Payload, "quarantineDir", security.DefaultQuarantineDir())

	// quarantineDir is caller-supplied: gate the destination too, or quarantine
	// implants the file's content wherever the caller points it.
	if err := tools.EnforcePathContainment("write", filepath.Clean(quarantineDir)); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	dest, err := security.QuarantineThreat(security.Threat{
		Name:     tools.GetPayloadString(cmd.Payload, "name", ""),
		Type:     tools.GetPayloadString(cmd.Payload, "threatType", "malware"),
		Severity: tools.GetPayloadString(cmd.Payload, "severity", "medium"),
		Path:     path,
	}, quarantineDir)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"path":          path,
		"quarantinedTo": dest,
		"status":        "quarantined",
	}, time.Since(start).Milliseconds())
}

func handleSecurityThreatRemove(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	path, errResult := tools.RequirePayloadString(cmd.Payload, "path")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	// Containment (#3397): destructive-but-not-disclosing, gated for the same
	// reason as tools.SecureDeleteFile — an unrecoverable delete of a credential
	// store is not a threat-remediation outcome anyone wants.
	// Check and use the same string, as every other call site in #3397 does.
	path = filepath.Clean(path)
	if err := tools.EnforcePathContainment("delete", path); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	err := security.RemoveThreat(security.Threat{
		Name:     tools.GetPayloadString(cmd.Payload, "name", ""),
		Type:     tools.GetPayloadString(cmd.Payload, "threatType", "malware"),
		Severity: tools.GetPayloadString(cmd.Payload, "severity", "medium"),
		Path:     path,
	})
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"path":   path,
		"status": "removed",
	}, time.Since(start).Milliseconds())
}

func handleSecurityThreatRestore(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	source, errResult := tools.RequirePayloadString(cmd.Payload, "quarantinedPath")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	originalPath, errResult := tools.RequirePayloadString(cmd.Payload, "originalPath")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}
	// Containment (#3397): both endpoints are caller-supplied, making restore an
	// arbitrary source→destination move. The source is read-gated (it relocates
	// content to an operator-chosen path) and the destination is write-gated
	// (otherwise this is a credential-implant primitive) — the same policy
	// tools.TrashRestore applies.
	cleanSource := filepath.Clean(source)
	cleanOriginal := filepath.Clean(originalPath)
	if err := tools.EnforcePathContainment("restore", cleanSource); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := tools.EnforcePathContainment("write", cleanOriginal); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	if _, err := security.RestoreQuarantined(cleanSource, cleanOriginal); err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to restore file: %w", err), time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"quarantinedPath": source,
		"originalPath":    originalPath,
		"status":          "restored",
	}, time.Since(start).Milliseconds())
}

func handleSensitiveDataScan(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ScanSensitiveData(cmd.Payload)
}

func handleEncryptFile(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.EncryptFile(cmd.Payload)
}

func handleSecureDeleteFile(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.SecureDeleteFile(cmd.Payload)
}

func handleQuarantineFile(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.QuarantineFile(cmd.Payload)
}
