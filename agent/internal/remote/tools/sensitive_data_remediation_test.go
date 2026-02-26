package tools

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixedKeyBase64(seed byte) string {
	key := strings.Repeat(string([]byte{seed}), 32)
	return base64.StdEncoding.EncodeToString([]byte(key))
}

func TestEncryptFileUsesRequestedKeySelection(t *testing.T) {
	t.Parallel()

	prevKeyring := os.Getenv("SENSITIVE_DATA_KEYRING_JSON")
	prevKey := os.Getenv("SENSITIVE_DATA_ENCRYPTION_KEY_B64")
	prevRef := os.Getenv("SENSITIVE_DATA_ENCRYPTION_KEY_REF")
	prevVersion := os.Getenv("SENSITIVE_DATA_ENCRYPTION_KEY_VERSION")
	t.Cleanup(func() {
		_ = os.Setenv("SENSITIVE_DATA_KEYRING_JSON", prevKeyring)
		_ = os.Setenv("SENSITIVE_DATA_ENCRYPTION_KEY_B64", prevKey)
		_ = os.Setenv("SENSITIVE_DATA_ENCRYPTION_KEY_REF", prevRef)
		_ = os.Setenv("SENSITIVE_DATA_ENCRYPTION_KEY_VERSION", prevVersion)
	})

	_ = os.Unsetenv("SENSITIVE_DATA_ENCRYPTION_KEY_B64")
	_ = os.Setenv("SENSITIVE_DATA_KEYRING_JSON", `{"team-a":{"v1":"`+fixedKeyBase64('A')+`","v2":"`+fixedKeyBase64('B')+`"}}`)
	_ = os.Setenv("SENSITIVE_DATA_ENCRYPTION_KEY_REF", "team-a")
	_ = os.Setenv("SENSITIVE_DATA_ENCRYPTION_KEY_VERSION", "v1")

	tempDir := t.TempDir()
	sourcePath := filepath.Join(tempDir, "note.txt")
	if err := os.WriteFile(sourcePath, []byte("hello world"), 0o600); err != nil {
		t.Fatalf("failed to create source file: %v", err)
	}

	result := EncryptFile(map[string]any{
		"path":                 sourcePath,
		"encryptionKeyRef":     "team-a",
		"encryptionKeyVersion": "v2",
	})
	if result.Status != "completed" {
		t.Fatalf("expected completed status, got %s (error=%s)", result.Status, result.Error)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("failed to parse result payload: %v", err)
	}

	if payload["keyRef"] != "team-a" {
		t.Fatalf("expected keyRef team-a, got %v", payload["keyRef"])
	}
	if payload["keyVersion"] != "v2" {
		t.Fatalf("expected keyVersion v2, got %v", payload["keyVersion"])
	}
	if payload["provider"] != "keyring" {
		t.Fatalf("expected provider keyring, got %v", payload["provider"])
	}

	if _, err := os.Stat(sourcePath); !os.IsNotExist(err) {
		t.Fatalf("expected source file to be deleted after encryption")
	}
	encryptedPath := sourcePath + ".breeze.enc"
	if _, err := os.Stat(encryptedPath); err != nil {
		t.Fatalf("expected encrypted file at %s: %v", encryptedPath, err)
	}
}
