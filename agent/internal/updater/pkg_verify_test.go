package updater

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"
)

func buildReleaseManifest(t *testing.T, release string, assets []releaseArtifactAsset) []byte {
	t.Helper()
	m := releaseArtifactManifest{SchemaVersion: 1, Release: release, Assets: assets}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	return b
}

// The macOS auto-update path must verify the downloaded .pkg against the
// Ed25519-signed release manifest before running `installer -pkg` as root.
// pkgAssetChecksum extracts that signed SHA-256 from an already-verified
// manifest payload; these tests pin its trust-binding behavior.

func TestPkgAssetChecksum_ReturnsSignedSHAForPkg(t *testing.T) {
	want := strings.Repeat("a", 64)
	pkgName := fmt.Sprintf("breeze-agent-darwin-%s.pkg", runtime.GOARCH)
	binName := fmt.Sprintf("breeze-agent-darwin-%s", runtime.GOARCH)
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: binName, SHA256: strings.Repeat("b", 64), Size: 10},
		{Name: pkgName, SHA256: want, Size: 20},
	})

	got, err := pkgAssetChecksum(payload, "1.2.3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != want {
		t.Fatalf("checksum = %s, want %s", got, want)
	}
}

func TestPkgAssetChecksum_FailsClosedWhenPkgAbsent(t *testing.T) {
	// Manifest lists only the bare binary, no .pkg. pkgAssetChecksum MUST error
	// so the caller falls back to verified-binary replacement rather than
	// running `installer` on bytes never bound to the signed trust root.
	binName := fmt.Sprintf("breeze-agent-darwin-%s", runtime.GOARCH)
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: binName, SHA256: strings.Repeat("b", 64), Size: 10},
	})

	if _, err := pkgAssetChecksum(payload, "1.2.3"); err == nil {
		t.Fatal("expected error when .pkg asset absent, got nil")
	}
}

func TestPkgAssetChecksum_RejectsVersionMismatch(t *testing.T) {
	pkgName := fmt.Sprintf("breeze-agent-darwin-%s.pkg", runtime.GOARCH)
	payload := buildReleaseManifest(t, "v9.9.9", []releaseArtifactAsset{
		{Name: pkgName, SHA256: strings.Repeat("a", 64), Size: 20},
	})

	if _, err := pkgAssetChecksum(payload, "1.2.3"); err == nil {
		t.Fatal("expected release-version-mismatch error, got nil")
	}
}

func TestPkgAssetChecksum_RejectsNonHexChecksum(t *testing.T) {
	pkgName := fmt.Sprintf("breeze-agent-darwin-%s.pkg", runtime.GOARCH)
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: pkgName, SHA256: strings.Repeat("z", 64), Size: 20}, // 64 chars but not hex
	})

	if _, err := pkgAssetChecksum(payload, "1.2.3"); err == nil {
		t.Fatal("expected non-hex checksum error, got nil")
	}
}

func TestPkgAssetChecksum_RejectsLegacyManifestWithoutAssets(t *testing.T) {
	// A legacy single-asset updateManifest (no assets list) has no .pkg entry →
	// fail closed.
	payload := []byte(`{"version":"1.2.3","component":"agent","checksum":"` + strings.Repeat("a", 64) + `"}`)
	if _, err := pkgAssetChecksum(payload, "1.2.3"); err == nil {
		t.Fatal("expected error for legacy manifest without assets, got nil")
	}
}
