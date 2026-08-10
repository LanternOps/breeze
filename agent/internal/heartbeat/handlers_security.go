package heartbeat

import (
	"fmt"
	"os"
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

	var (
		scanResult security.ScanResult
		err        error
	)
	switch scanType {
	case "quick":
		scanResult, err = h.securityScanner.QuickScan()
	case "full":
		scanResult, err = h.securityScanner.FullScan()
	case "custom":
		if len(paths) == 0 {
			err = fmt.Errorf("custom scan requires one or more paths")
		} else {
			scanResult, err = h.securityScanner.CustomScan(paths)
		}
	default:
		err = fmt.Errorf("unsupported scanType: %s", scanType)
	}

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
		"durationMs":   scanResult.Duration.Milliseconds(),
		"threatsFound": len(scanResult.Threats),
		"threats":      scanResult.Threats,
		"status":       scanResult.Status,
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
	if err := tools.EnforcePathContainment("quarantine", filepath.Clean(path)); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	quarantineDir := tools.GetPayloadString(cmd.Payload, "quarantineDir", security.DefaultQuarantineDir())
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
	if err := tools.EnforcePathContainment("delete", filepath.Clean(path)); err != nil {
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

	if err := os.MkdirAll(filepath.Dir(cleanOriginal), 0755); err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to create restore directory: %w", err), time.Since(start).Milliseconds())
	}
	if err := os.Rename(cleanSource, cleanOriginal); err != nil {
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
