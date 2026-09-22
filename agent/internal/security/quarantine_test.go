package security

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestQuarantineNeutralizesTheFileOnDisk(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, "sample.bin")
	// A byte pattern with no meaning to any AV: the point is that the bytes on
	// disk after quarantine are NOT these bytes.
	original := []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77}
	if err := os.WriteFile(victim, original, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	qdir := filepath.Join(root, "quarantine")
	dest, err := QuarantineThreat(Threat{Name: "T", Type: "malware", Severity: "high", Path: victim}, qdir)
	if err != nil {
		t.Fatalf("QuarantineThreat: %v", err)
	}
	if !strings.HasSuffix(dest, ".bqz") {
		t.Fatalf("dest = %q, want a .bqz payload", dest)
	}
	if _, err := os.Stat(victim); !os.IsNotExist(err) {
		t.Fatalf("original still on disk: %v", err)
	}

	stored, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if string(stored) == string(original) {
		t.Fatal("quarantined bytes are identical to the original — not neutralized")
	}
	for i := range original {
		if stored[i] != original[i]^0x5A {
			t.Fatalf("byte %d = %#x, want %#x", i, stored[i], original[i]^0x5A)
		}
	}
}

func TestQuarantineWritesAManifestWithTheOriginalDigest(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, "sample.bin")
	original := []byte("hello quarantine")
	if err := os.WriteFile(victim, original, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	dest, err := QuarantineThreat(Threat{Name: "T", Path: victim}, filepath.Join(root, "q"))
	if err != nil {
		t.Fatalf("QuarantineThreat: %v", err)
	}

	raw, err := os.ReadFile(dest + ".json")
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var m QuarantineManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal manifest: %v", err)
	}
	sum := sha256.Sum256(original)
	if m.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("manifest sha256 = %q, want the ORIGINAL digest", m.SHA256)
	}
	if m.OriginalPath != victim || m.V != 1 {
		t.Fatalf("manifest = %+v", m)
	}
}

func TestRestoreRoundTripsTheOriginalBytes(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, "sample.bin")
	original := []byte("round trip me exactly")
	if err := os.WriteFile(victim, original, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	dest, err := QuarantineThreat(Threat{Name: "T", Path: victim}, filepath.Join(root, "q"))
	if err != nil {
		t.Fatalf("QuarantineThreat: %v", err)
	}

	restored, err := RestoreQuarantined(dest, "")
	if err != nil {
		t.Fatalf("RestoreQuarantined: %v", err)
	}
	if restored != victim {
		t.Fatalf("restored to %q, want the manifest's originalPath %q", restored, victim)
	}
	got, err := os.ReadFile(victim)
	if err != nil {
		t.Fatalf("read restored: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("restored bytes = %q, want %q", got, original)
	}
	if _, err := os.Stat(dest + ".json"); !os.IsNotExist(err) {
		t.Fatal("manifest survived a successful restore")
	}
}

func TestRestoreFallsBackToPlainRenameForLegacyEntries(t *testing.T) {
	// A pre-W01 quarantine entry: a plain renamed file, no .bqz, no manifest.
	root := t.TempDir()
	legacy := filepath.Join(root, "q", "sample.bin-1750000000")
	if err := os.MkdirAll(filepath.Dir(legacy), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(legacy, []byte("legacy bytes"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	target := filepath.Join(root, "restored.bin")

	restored, err := RestoreQuarantined(legacy, target)
	if err != nil {
		t.Fatalf("RestoreQuarantined: %v", err)
	}
	got, err := os.ReadFile(restored)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "legacy bytes" {
		t.Fatalf("legacy restore corrupted the file: %q", got)
	}
}

func TestRestoreRefusesWithoutATarget(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "orphan")
	if err := os.WriteFile(legacy, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := RestoreQuarantined(legacy, ""); err == nil {
		t.Fatal("expected an error: no manifest and no explicit originalPath")
	}
}
