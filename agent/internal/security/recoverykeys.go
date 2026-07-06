package security

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
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

var (
	bitlockerMountPattern = regexp.MustCompile(`^[A-Za-z]:$`)
	protectorIDPattern    = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)
	// FileVault personal recovery keys: six dash-separated groups of four.
	fileVaultKeyPattern = regexp.MustCompile(`[A-Z0-9]{4}(?:-[A-Z0-9]{4}){5}`)
)

func validBitLockerMount(mount string) bool { return bitlockerMountPattern.MatchString(mount) }
func validProtectorID(id string) bool       { return protectorIDPattern.MatchString(id) }

// RotateBitLockerKey adds a new recovery-password protector BEFORE removing
// the old ones, so the volume always has at least one recovery password. On
// partial failure (new key added, old removal failed) it returns the NEW key
// alongside the error — the caller must still escrow it.
func RotateBitLockerKey(mount string) (RecoveryKey, error) {
	if runtime.GOOS != "windows" {
		return RecoveryKey{}, errors.New("bitlocker rotation is only supported on windows")
	}
	mount = strings.ToUpper(strings.TrimSpace(mount))
	if !validBitLockerMount(mount) {
		return RecoveryKey{}, fmt.Errorf("invalid volume mount %q", mount)
	}

	before, err := CollectRecoveryKeys()
	if err != nil {
		return RecoveryKey{}, fmt.Errorf("collect before rotation: %w", err)
	}
	oldIDs := make(map[string]bool)
	for _, k := range before {
		if strings.EqualFold(k.Mount, mount) {
			oldIDs[k.ProtectorID] = true
		}
	}

	if _, err := runCommand(30*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command",
		fmt.Sprintf("Add-BitLockerKeyProtector -MountPoint '%s' -RecoveryPasswordProtector | Out-Null", mount)); err != nil {
		return RecoveryKey{}, fmt.Errorf("add recovery password protector: %w", err)
	}

	after, err := CollectRecoveryKeys()
	if err != nil {
		return RecoveryKey{}, fmt.Errorf("collect after rotation: %w", err)
	}
	var newKey *RecoveryKey
	for i := range after {
		if strings.EqualFold(after[i].Mount, mount) && !oldIDs[after[i].ProtectorID] {
			newKey = &after[i]
			break
		}
	}
	if newKey == nil {
		return RecoveryKey{}, errors.New("new recovery password protector not found after add")
	}

	for id := range oldIDs {
		if !validProtectorID(id) {
			return *newKey, fmt.Errorf("new protector added but old protector id %q is malformed; remove it manually", id)
		}
		if _, err := runCommand(30*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command",
			fmt.Sprintf("Remove-BitLockerKeyProtector -MountPoint '%s' -KeyProtectorId '{%s}' | Out-Null", mount, id)); err != nil {
			return *newKey, fmt.Errorf("new protector added but removing old protector failed: %w", err)
		}
	}
	return *newKey, nil
}

func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// buildFileVaultAuthPlist builds the -inputplist body for fdesetup. With a
// username the auth is user credentials; without, Password carries the
// current personal recovery key.
func buildFileVaultAuthPlist(username, password, currentRecoveryKey string) string {
	if username != "" {
		return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Username</key><string>%s</string><key>Password</key><string>%s</string></dict></plist>`,
			xmlEscape(username), xmlEscape(password))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Password</key><string>%s</string></dict></plist>`,
		xmlEscape(currentRecoveryKey))
}

func parseFileVaultNewKey(output string) (string, error) {
	match := fileVaultKeyPattern.FindString(output)
	if match == "" {
		// Do NOT embed output in the error: on success paths it contains the key.
		return "", errors.New("no personal recovery key found in fdesetup output")
	}
	return match, nil
}

// RotateFileVaultKey rotates the FileVault personal recovery key via
// `fdesetup changerecovery -personal -inputplist` (plist over stdin — never
// on disk or argv) and returns the NEW key for escrow. Error messages and
// logs must never contain the key, the password, or raw fdesetup output.
func RotateFileVaultKey(username, password, currentRecoveryKey string) (RecoveryKey, error) {
	if runtime.GOOS != "darwin" {
		return RecoveryKey{}, errors.New("filevault rotation is only supported on macos")
	}
	if (username == "" || password == "") && currentRecoveryKey == "" {
		return RecoveryKey{}, errors.New("filevault rotation requires user credentials or the current recovery key")
	}

	plist := buildFileVaultAuthPlist(username, password, currentRecoveryKey)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "fdesetup", "changerecovery", "-personal", "-inputplist")
	cmd.Stdin = strings.NewReader(plist)
	outputBytes, err := cmd.CombinedOutput()
	output := string(outputBytes)
	if err != nil {
		// fdesetup exits non-zero on auth failure; output may echo details but
		// never include it in the returned error (success output holds the key).
		return RecoveryKey{}, fmt.Errorf("fdesetup changerecovery failed: %w", err)
	}
	newKey, err := parseFileVaultNewKey(output)
	if err != nil {
		return RecoveryKey{}, err
	}
	return RecoveryKey{Mount: "/", KeyType: KeyTypeFileVault, Key: newKey}, nil
}
