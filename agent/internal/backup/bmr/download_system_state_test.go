package bmr

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// memStateProvider is an in-memory BackupProvider for DownloadSystemState
// tests that need to tamper with already-"uploaded" bytes directly (a real
// LocalProvider writes to disk, which is fine for the existing
// applySystemState fixtures but awkward for a "corrupt this one object"
// test).
type memStateProvider struct{ files map[string][]byte }

func (m *memStateProvider) Upload(local, remote string) error {
	b, err := os.ReadFile(local)
	if err != nil {
		return err
	}
	m.files[remote] = b
	return nil
}
func (m *memStateProvider) Download(remote, local string) error {
	b, ok := m.files[remote]
	if !ok {
		return os.ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return err
	}
	return os.WriteFile(local, b, 0o600)
}
func (m *memStateProvider) List(prefix string) ([]string, error) {
	var out []string
	for k := range m.files {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	return out, nil
}
func (m *memStateProvider) Delete(remote string) error { delete(m.files, remote); return nil }

func stateSum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// seedSystemStateSnapshot builds a minimal system-state/manifest.json plus
// one artifact per entry in artifacts (path -> content) for snapshotID.
func seedSystemStateSnapshot(t *testing.T, artifacts map[string][]byte) (*memStateProvider, string) {
	t.Helper()
	snapshotID := "snap-download-state"
	p := &memStateProvider{files: map[string][]byte{}}
	var man systemstate.SystemStateManifest
	man.SchemaVersion = 1
	for artifactPath, content := range artifacts {
		key := "snapshots/" + snapshotID + "/system-state/" + artifactPath
		p.files[key] = content
		man.Artifacts = append(man.Artifacts, systemstate.Artifact{
			Name: strings.SplitN(artifactPath, "/", 2)[0], Category: "test", Path: artifactPath,
			SizeBytes: int64(len(content)), Checksum: stateSum(content),
		})
	}
	data, err := json.Marshal(man)
	if err != nil {
		t.Fatal(err)
	}
	p.files["snapshots/"+snapshotID+"/system-state/manifest.json"] = data
	return p, snapshotID
}

func TestDownloadSystemState_VerifiesArtifacts(t *testing.T) {
	provider, snapshotID := seedSystemStateSnapshot(t, map[string][]byte{"services/systemd.txt": []byte("ssh.service\n")})
	dir := t.TempDir()
	m, warnings, err := DownloadSystemState(context.Background(), provider, snapshotID, true, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 || m == nil || len(m.Artifacts) != 1 {
		t.Fatalf("m=%+v warnings=%v", m, warnings)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "services", "systemd.txt")); err != nil || string(b) != "ssh.service\n" {
		t.Fatalf("artifact = %q err=%v", b, err)
	}
	// Tamper → error names the artifact.
	provider.files["snapshots/"+snapshotID+"/system-state/services/systemd.txt"] = []byte("evil\n")
	if _, _, err := DownloadSystemState(context.Background(), provider, snapshotID, true, t.TempDir()); err == nil || !strings.Contains(err.Error(), "services/systemd.txt") {
		t.Fatalf("tamper err = %v", err)
	}
}

func TestDownloadSystemState_NoManifest_ExpectFalse_ReturnsSentinel(t *testing.T) {
	provider := &memStateProvider{files: map[string][]byte{}}
	_, _, err := DownloadSystemState(context.Background(), provider, "nope", false, t.TempDir())
	if !errors.Is(err, ErrNoSystemState) {
		t.Fatalf("err = %v, want ErrNoSystemState", err)
	}
}

func TestDownloadSystemState_NoManifest_ExpectTrue_Fatal(t *testing.T) {
	provider := &memStateProvider{files: map[string][]byte{}}
	_, _, err := DownloadSystemState(context.Background(), provider, "nope", true, t.TempDir())
	if err == nil || errors.Is(err, ErrNoSystemState) {
		t.Fatalf("err = %v, want a hard (non-sentinel) error", err)
	}
}
