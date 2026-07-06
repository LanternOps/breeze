package heartbeat

import (
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
)

func init() {
	handlerRegistry[tools.CmdEncryptionCollectKeys] = handleEncryptionCollectKeys
	handlerRegistry[tools.CmdEncryptionRotateKey] = handleEncryptionRotateKey
}

// handleEncryptionCollectKeys re-collects BitLocker recovery keys and pushes a
// full snapshot immediately. Results carry counts only — never key material.
func handleEncryptionCollectKeys(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	keys, err := security.CollectRecoveryKeys()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := h.pushRecoveryKeys("snapshot", keys); err != nil {
		return tools.NewErrorResult(fmt.Errorf("collected %d recovery keys but escrow upload failed: %w", len(keys), err), time.Since(start).Milliseconds())
	}
	h.mu.Lock()
	h.lastRecoveryKeysFP = security.FingerprintRecoveryKeys(keys)
	h.mu.Unlock()
	return tools.NewSuccessResult(map[string]any{"keysCollected": len(keys)}, time.Since(start).Milliseconds())
}

// handleEncryptionRotateKey rotates the recovery key and escrows the new one.
// A generated-but-unescrowed key is unrecoverable (FileVault), so on upload
// failure the key is parked on the heartbeat for retry on the next security
// tick. The CommandResult never contains key or credential material.
func handleEncryptionRotateKey(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	var (
		key       security.RecoveryKey
		rotateErr error
	)
	switch runtime.GOOS {
	case "windows":
		mount := strings.ToUpper(tools.GetPayloadString(cmd.Payload, "volumeMount", "C:"))
		key, rotateErr = security.RotateBitLockerKey(mount)
	case "darwin":
		username := tools.GetPayloadString(cmd.Payload, "username", "")
		password := tools.GetPayloadString(cmd.Payload, "password", "")
		currentKey := tools.GetPayloadString(cmd.Payload, "currentRecoveryKey", "")
		key, rotateErr = security.RotateFileVaultKey(username, password, currentKey)
	default:
		return tools.NewErrorResult(fmt.Errorf("recovery key rotation is not supported on %s", runtime.GOOS), time.Since(start).Milliseconds())
	}

	if key.Key != "" {
		if pushErr := h.pushRecoveryKeys("rotation", []security.RecoveryKey{key}); pushErr != nil {
			h.mu.Lock()
			h.pendingRecoveryKeys = append(h.pendingRecoveryKeys, key)
			h.mu.Unlock()
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
