package desktop

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyFileSHA256(t *testing.T) {
	dir := t.TempDir()

	good := filepath.Join(dir, "good.bin")
	content := []byte("pretend this is a DLL")
	if err := os.WriteFile(good, content, 0o644); err != nil {
		t.Fatalf("write good file: %v", err)
	}
	sum := sha256.Sum256(content)
	expected := hex.EncodeToString(sum[:])

	ok, err := verifyFileSHA256(good, expected)
	if err != nil {
		t.Fatalf("verifyFileSHA256(good): %v", err)
	}
	if !ok {
		t.Error("expected matching content to verify")
	}

	tampered := filepath.Join(dir, "tampered.bin")
	if err := os.WriteFile(tampered, []byte("something else entirely"), 0o644); err != nil {
		t.Fatalf("write tampered file: %v", err)
	}
	ok, err = verifyFileSHA256(tampered, expected)
	if err != nil {
		t.Fatalf("verifyFileSHA256(tampered): %v", err)
	}
	if ok {
		t.Error("expected mismatched content to fail verification")
	}

	missing := filepath.Join(dir, "does-not-exist.bin")
	if _, err := verifyFileSHA256(missing, expected); err == nil {
		t.Error("expected an error verifying a missing file, not a silent pass")
	}
}
