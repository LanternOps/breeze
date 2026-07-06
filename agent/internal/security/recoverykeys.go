package security

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"time"
)

// RecoveryKey is one escrowable disk-encryption recovery key. JSON tags match
// the API ingest schema (apps/api/src/routes/agents/schemas.ts
// recoveryKeysIngestSchema). Key material must never be logged.
type RecoveryKey struct {
	Mount       string `json:"volumeMount,omitempty"`
	ProtectorID string `json:"protectorId,omitempty"`
	KeyType     string `json:"keyType"`
	Key         string `json:"recoveryKey"`
}

const (
	KeyTypeBitLocker = "bitlocker_recovery_password"
	KeyTypeFileVault = "filevault_personal_recovery_key"
)

// @() forces an array even for a single protector (PowerShell 5.1 collapses
// one-element pipelines to a bare object otherwise); the parser still handles
// a bare object defensively.
const bitlockerKeyProtectorPS = `$r = Get-BitLockerVolume | ForEach-Object { $mp = $_.MountPoint; $_.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' } | ForEach-Object { [PSCustomObject]@{ Mount = $mp; ProtectorId = "$($_.KeyProtectorId)"; RecoveryPassword = $_.RecoveryPassword } } }; if ($null -eq $r) { '[]' } else { ConvertTo-Json -InputObject @($r) -Compress }`

// CollectRecoveryKeys reads all BitLocker recovery-password protectors.
// Windows only; other platforms return (nil, nil) — FileVault keys cannot be
// read after enablement and are escrowed via the rotate command instead.
func CollectRecoveryKeys() ([]RecoveryKey, error) {
	if runtime.GOOS != "windows" {
		return nil, nil
	}
	output, err := runCommand(
		20*time.Second,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		bitlockerKeyProtectorPS,
	)
	if err != nil {
		return nil, fmt.Errorf("bitlocker key protector query failed: %w", err)
	}
	return parseBitLockerRecoveryKeys(output)
}

func parseBitLockerRecoveryKeys(output string) ([]RecoveryKey, error) {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return nil, nil
	}
	parsed, err := parseJSONValue(trimmed)
	if err != nil {
		return nil, fmt.Errorf("parse bitlocker key protector output: %w", err)
	}
	keys := make([]RecoveryKey, 0)
	for _, item := range toObjectSlice(parsed) {
		mount, _ := stringFromAny(item["Mount"])
		protectorID, _ := stringFromAny(item["ProtectorId"])
		password, _ := stringFromAny(item["RecoveryPassword"])
		if password == "" {
			continue
		}
		keys = append(keys, RecoveryKey{
			Mount:       strings.ToUpper(strings.TrimSpace(mount)),
			ProtectorID: strings.Trim(strings.TrimSpace(protectorID), "{}"),
			KeyType:     KeyTypeBitLocker,
			Key:         password,
		})
	}
	return keys, nil
}

// FingerprintRecoveryKeys returns a stable, order-insensitive digest of a key
// set. Used to gate transmission: only send when the set changed. Empty set →
// "" (matches the "never sent" initial state, so agents with no keys stay quiet).
func FingerprintRecoveryKeys(keys []RecoveryKey) string {
	if len(keys) == 0 {
		return ""
	}
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		sum := sha256.Sum256([]byte(k.Key))
		parts = append(parts, k.KeyType+"|"+strings.ToUpper(k.Mount)+"|"+k.ProtectorID+"|"+hex.EncodeToString(sum[:]))
	}
	sort.Strings(parts)
	total := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(total[:])
}
