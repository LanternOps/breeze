package tools

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxEncryptFileBytes = int64(100 * 1024 * 1024)

func quarantineDefaultDir() string {
	return filepath.Join(os.TempDir(), "breeze-quarantine")
}

func sanitizeFileName(name string) string {
	replacer := strings.NewReplacer("/", "_", "\\", "_", ":", "_")
	return replacer.Replace(name)
}

// QuarantineFile moves the target file into a quarantine directory.
func QuarantineFile(payload map[string]any) CommandResult {
	start := time.Now()
	path, errResult := RequirePayloadString(payload, "path")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	quarantineDir := GetPayloadString(payload, "quarantineDir", quarantineDefaultDir())
	sourcePath := filepath.Clean(path)
	info, err := os.Stat(sourcePath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to stat file: %w", err), time.Since(start).Milliseconds())
	}
	if !info.Mode().IsRegular() {
		return NewErrorResult(fmt.Errorf("path is not a regular file"), time.Since(start).Milliseconds())
	}

	if err := os.MkdirAll(quarantineDir, 0o700); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create quarantine directory: %w", err), time.Since(start).Milliseconds())
	}

	targetName := fmt.Sprintf("%d_%s", time.Now().UnixNano(), sanitizeFileName(filepath.Base(sourcePath)))
	targetPath := filepath.Join(quarantineDir, targetName)

	if err := os.Rename(sourcePath, targetPath); err != nil {
		return NewErrorResult(fmt.Errorf("failed to move file to quarantine: %w", err), time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"path":           sourcePath,
		"quarantinedTo":  targetPath,
		"status":         "quarantined",
		"quarantinePath": targetPath,
	}, time.Since(start).Milliseconds())
}

func secureDeletePath(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("path is not a regular file")
	}

	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}

	defer file.Close()

	buffer := make([]byte, 64*1024)
	remaining := info.Size()
	for remaining > 0 {
		chunk := int64(len(buffer))
		if remaining < chunk {
			chunk = remaining
		}
		if _, err := io.ReadFull(rand.Reader, buffer[:chunk]); err != nil {
			return err
		}
		if _, err := file.Write(buffer[:chunk]); err != nil {
			return err
		}
		remaining -= chunk
	}

	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Remove(path)
}

// SecureDeleteFile securely overwrites and deletes a file.
func SecureDeleteFile(payload map[string]any) CommandResult {
	start := time.Now()
	path, errResult := RequirePayloadString(payload, "path")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	targetPath := filepath.Clean(path)
	if err := secureDeletePath(targetPath); err != nil {
		return NewErrorResult(fmt.Errorf("secure delete failed: %w", err), time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"path":   targetPath,
		"status": "deleted",
	}, time.Since(start).Milliseconds())
}

func decodeEncryptionKey(encoded string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil, fmt.Errorf("invalid base64 encryption key: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("encryption key must decode to 32 bytes")
	}
	return key, nil
}

func parseSensitiveKeyring(raw string) map[string]map[string]string {
	parsed := map[string]map[string]string{}
	if strings.TrimSpace(raw) == "" {
		return parsed
	}

	var input map[string]map[string]string
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return parsed
	}

	for ref, versions := range input {
		normalizedRef := strings.TrimSpace(ref)
		if normalizedRef == "" || len(versions) == 0 {
			continue
		}
		normalizedVersions := map[string]string{}
		for version, value := range versions {
			normalizedVersion := strings.TrimSpace(version)
			normalizedValue := strings.TrimSpace(value)
			if normalizedVersion == "" || normalizedValue == "" {
				continue
			}
			normalizedVersions[normalizedVersion] = normalizedValue
		}
		if len(normalizedVersions) > 0 {
			parsed[normalizedRef] = normalizedVersions
		}
	}

	return parsed
}

func latestKeyVersion(versions map[string]string) string {
	keys := make([]string, 0, len(versions))
	for version := range versions {
		keys = append(keys, version)
	}
	if len(keys) == 0 {
		return ""
	}
	sort.Strings(keys)
	return keys[len(keys)-1]
}

func firstKeyRef(keyring map[string]map[string]string) string {
	refs := make([]string, 0, len(keyring))
	for ref := range keyring {
		refs = append(refs, ref)
	}
	if len(refs) == 0 {
		return ""
	}
	sort.Strings(refs)
	return refs[0]
}

func resolveFileEncryptionKey(payload map[string]any) ([]byte, string, string, string, error) {
	requestedRef := strings.TrimSpace(GetPayloadString(payload, "encryptionKeyRef", ""))
	requestedVersion := strings.TrimSpace(GetPayloadString(payload, "encryptionKeyVersion", ""))
	defaultRef := strings.TrimSpace(os.Getenv("SENSITIVE_DATA_ENCRYPTION_KEY_REF"))
	defaultVersion := strings.TrimSpace(os.Getenv("SENSITIVE_DATA_ENCRYPTION_KEY_VERSION"))

	keyring := parseSensitiveKeyring(os.Getenv("SENSITIVE_DATA_KEYRING_JSON"))
	if len(keyring) > 0 {
		selectedRef := requestedRef
		if selectedRef == "" {
			selectedRef = defaultRef
		}
		if selectedRef == "" {
			selectedRef = firstKeyRef(keyring)
		}
		versions := keyring[selectedRef]
		if len(versions) == 0 {
			return nil, "", "", "", fmt.Errorf("no keys found for keyRef %q", selectedRef)
		}

		selectedVersion := requestedVersion
		if selectedVersion == "" && defaultVersion != "" {
			if _, ok := versions[defaultVersion]; ok {
				selectedVersion = defaultVersion
			}
		}
		if selectedVersion == "" {
			selectedVersion = latestKeyVersion(versions)
		}
		encodedKey, ok := versions[selectedVersion]
		if !ok {
			return nil, "", "", "", fmt.Errorf("keyRef %q does not include version %q", selectedRef, selectedVersion)
		}
		key, err := decodeEncryptionKey(encodedKey)
		if err != nil {
			return nil, "", "", "", err
		}
		return key, selectedRef, selectedVersion, "keyring", nil
	}

	singleKey := strings.TrimSpace(os.Getenv("SENSITIVE_DATA_ENCRYPTION_KEY_B64"))
	if singleKey == "" {
		return nil, "", "", "", fmt.Errorf("missing SENSITIVE_DATA_ENCRYPTION_KEY_B64")
	}
	key, err := decodeEncryptionKey(singleKey)
	if err != nil {
		return nil, "", "", "", err
	}

	keyRef := requestedRef
	if keyRef == "" {
		if defaultRef != "" {
			keyRef = defaultRef
		} else {
			keyRef = "default"
		}
	}
	keyVersion := requestedVersion
	if keyVersion == "" {
		if defaultVersion != "" {
			keyVersion = defaultVersion
		} else {
			keyVersion = "v1"
		}
	}

	return key, keyRef, keyVersion, "env_b64", nil
}

// EncryptFile encrypts a file in-place to <name>.breeze.enc and removes the source.
func EncryptFile(payload map[string]any) CommandResult {
	start := time.Now()
	path, errResult := RequirePayloadString(payload, "path")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	sourcePath := filepath.Clean(path)
	info, err := os.Stat(sourcePath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to stat file: %w", err), time.Since(start).Milliseconds())
	}
	if !info.Mode().IsRegular() {
		return NewErrorResult(fmt.Errorf("path is not a regular file"), time.Since(start).Milliseconds())
	}
	if info.Size() > maxEncryptFileBytes {
		return NewErrorResult(fmt.Errorf("file too large for encryption (max %d bytes)", maxEncryptFileBytes), time.Since(start).Milliseconds())
	}

	key, keyRef, keyVersion, provider, err := resolveFileEncryptionKey(payload)
	if err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	plaintext, err := os.ReadFile(sourcePath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read file: %w", err), time.Since(start).Milliseconds())
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to initialize cipher: %w", err), time.Since(start).Milliseconds())
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to initialize GCM: %w", err), time.Since(start).Milliseconds())
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return NewErrorResult(fmt.Errorf("failed to generate nonce: %w", err), time.Since(start).Milliseconds())
	}

	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	targetPath := sourcePath + ".breeze.enc"
	tempPath := targetPath + ".tmp"

	if err := os.WriteFile(tempPath, ciphertext, 0o600); err != nil {
		return NewErrorResult(fmt.Errorf("failed to write encrypted file: %w", err), time.Since(start).Milliseconds())
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return NewErrorResult(fmt.Errorf("failed to finalize encrypted file: %w", err), time.Since(start).Milliseconds())
	}

	if err := secureDeletePath(sourcePath); err != nil {
		return NewErrorResult(fmt.Errorf("encrypted file written but source wipe failed: %w", err), time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"path":          sourcePath,
		"encryptedPath": targetPath,
		"status":        "encrypted",
		"algorithm":     "AES-256-GCM",
		"keyRef":        keyRef,
		"keyVersion":    keyVersion,
		"provider":      provider,
	}, time.Since(start).Milliseconds())
}
