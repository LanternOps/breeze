package sessionbroker

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestHashFileSHA256(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	path := filepath.Join(tmpDir, "bin")
	data := []byte("breeze-agent")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := hashFileSHA256(path)
	if err != nil {
		t.Fatalf("hashFileSHA256: %v", err)
	}
	sum := sha256.Sum256(data)
	want := hex.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("hashFileSHA256 = %q, want %q", got, want)
	}
}
