package heartbeat

import (
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
)

// collectRecoveryKeys is a seam for tests; production reads BitLocker
// recovery protectors (one PowerShell spawn on Windows).
var collectRecoveryKeys = security.CollectRecoveryKeys

// Rotation seams for tests.
var (
	rotateBitLockerKey = security.RotateBitLockerKey
	rotateFileVaultKey = security.RotateFileVaultKey
)

// recoveryKeyCollectInterval bounds how often the 5-minute security tick
// re-reads BitLocker recovery protectors (#9267). Protectors change only when
// BitLocker is enabled or a key is rotated; rotation through Breeze resets
// the interval and escrows the new key directly, and the explicit collect
// command bypasses it. Key material is never cached between reads — only the
// time of the last read and the fingerprint of what was escrowed.
const recoveryKeyCollectInterval = 30 * time.Minute

// recoveryKeyErrorRetry is the wait after a failed read (matches the security
// package's slowProbeErrorTTL): a persistent failure, such as no BitLocker
// module on Home editions, is not re-spawned every tick.
const recoveryKeyErrorRetry = 10 * time.Minute

func init() {
	handlerRegistry[tools.CmdEncryptionCollectKeys] = handleEncryptionCollectKeys
	handlerRegistry[tools.CmdEncryptionRotateKey] = handleEncryptionRotateKey
}

// handleEncryptionCollectKeys re-collects BitLocker recovery keys and pushes a
// full snapshot immediately. Results carry counts only — never key material.
func handleEncryptionCollectKeys(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	keys, err := collectRecoveryKeys()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := h.pushRecoveryKeys("snapshot", keys); err != nil {
		return tools.NewErrorResult(fmt.Errorf("collected %d recovery keys but escrow upload failed: %w", len(keys), err), time.Since(start).Milliseconds())
	}
	h.mu.Lock()
	h.lastRecoveryKeysFP = security.FingerprintRecoveryKeys(keys)
	h.lastRecoveryKeysCollect = time.Now()
	h.mu.Unlock()
	return tools.NewSuccessResult(map[string]any{"keysCollected": len(keys)}, time.Since(start).Milliseconds())
}

// handleEncryptionRotateKey rotates the recovery key and escrows the new one.
// A generated-but-unescrowed key is unrecoverable (FileVault), so on upload
// failure the key is parked on the heartbeat for retry on the next security
// tick. The CommandResult never contains key or credential material.
func handleEncryptionRotateKey(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	// Rotation changed (or may have partly changed) the protector set: once it
	// returns, have the next security tick re-read and re-snapshot it instead
	// of waiting out recoveryKeyCollectInterval (#9267).
	defer func() {
		h.mu.Lock()
		h.lastRecoveryKeysCollect = time.Time{}
		h.mu.Unlock()
	}()
	var (
		key       security.RecoveryKey
		rotateErr error
	)
	switch runtime.GOOS {
	case "windows":
		mount := strings.ToUpper(tools.GetPayloadString(cmd.Payload, "volumeMount", "C:"))
		key, rotateErr = rotateBitLockerKey(mount)
	case "darwin":
		username := tools.GetPayloadString(cmd.Payload, "username", "")
		password := tools.GetPayloadString(cmd.Payload, "password", "")
		currentKey := tools.GetPayloadString(cmd.Payload, "currentRecoveryKey", "")
		key, rotateErr = rotateFileVaultKey(username, password, currentKey)
	default:
		return tools.NewErrorResult(fmt.Errorf("recovery key rotation is not supported on %s", runtime.GOOS), time.Since(start).Milliseconds())
	}

	if key.Key != "" {
		if pushErr := h.pushRecoveryKeys("rotation", []security.RecoveryKey{key}); pushErr != nil {
			h.mu.Lock()
			h.pendingRecoveryKeys = append(h.pendingRecoveryKeys, key)
			h.mu.Unlock()
			// The rotated key now protects the volume but isn't escrowed yet. A
			// FileVault personal recovery key in particular cannot be
			// re-collected, and the parked copy lives only in memory — an agent
			// restart before the next-tick retry loses it. Log loudly (never the
			// key material) so ops sees it; the command result below also returns
			// failed so the tech is signalled to re-rotate.
			log.Error("recovery key rotated but escrow upload failed — key is parked in memory and will be LOST on agent restart; re-rotate if this persists",
				"keyType", key.KeyType, "volumeMount", key.Mount, "error", pushErr.Error())
			if rotateErr == nil {
				rotateErr = fmt.Errorf("key rotated but escrow upload failed; will retry on next security tick: %w", pushErr)
			}
		}
	}
	if rotateErr != nil {
		return tools.NewErrorResult(rotateErr, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"rotated":     true,
		"keyType":     key.KeyType,
		"volumeMount": key.Mount,
	}, time.Since(start).Milliseconds())
}
