package updater

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

const recoveryAssetForTest = "breeze-isolation-recovery-windows-amd64.exe"

type signedRecoveryManifest struct {
	payload, signature, keyID string
	updater                   *Updater
}

func signRecoveryManifest(t *testing.T, release string, assets []releaseArtifactAsset) signedRecoveryManifest {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := buildReleaseManifest(t, release, assets)
	keyID := "deployment-test-key"
	return signedRecoveryManifest{
		payload:   string(payload),
		signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload)),
		keyID:     keyID,
		updater: &Updater{config: &Config{
			PinnedManifestPubKeys:       []string{keyID + ":" + base64.StdEncoding.EncodeToString(pub)},
			RequireManifestSigningKeyID: true,
		}},
	}
}

// The self-host recovery trust path (isolation W17) must reuse the exact
// Ed25519 release-manifest trust decision the updater makes for downloads.
func TestVerifiedReleaseAssetSHA256(t *testing.T) {
	sha := strings.Repeat("ab", 32)
	good := []releaseArtifactAsset{{Name: recoveryAssetForTest, SHA256: sha, Size: 10}}
	t.Run("signed manifest entry", func(t *testing.T) {
		m := signRecoveryManifest(t, "v1.2.3", good)
		got, err := m.updater.VerifiedReleaseAssetSHA256(m.payload, m.signature, m.keyID, "1.2.3", recoveryAssetForTest)
		if err != nil || got != sha {
			t.Fatalf("got %q, %v", got, err)
		}
	})
	t.Run("tampered payload", func(t *testing.T) {
		m := signRecoveryManifest(t, "1.2.3", good)
		tampered := strings.Replace(m.payload, sha, strings.Repeat("cd", 32), 1)
		_, err := m.updater.VerifiedReleaseAssetSHA256(tampered, m.signature, m.keyID, "1.2.3", recoveryAssetForTest)
		if !errors.Is(err, ErrManifestSignature) {
			t.Fatalf("want ErrManifestSignature, got %v", err)
		}
	})
	t.Run("unsigned", func(t *testing.T) {
		m := signRecoveryManifest(t, "1.2.3", good)
		if _, err := m.updater.VerifiedReleaseAssetSHA256(m.payload, "", m.keyID, "1.2.3", recoveryAssetForTest); !errors.Is(err, ErrManifestSignature) {
			t.Fatalf("want ErrManifestSignature, got %v", err)
		}
	})
	t.Run("unknown signing key", func(t *testing.T) {
		m := signRecoveryManifest(t, "1.2.3", good)
		other := signRecoveryManifest(t, "1.2.3", good)
		if _, err := other.updater.VerifiedReleaseAssetSHA256(m.payload, m.signature, m.keyID, "1.2.3", recoveryAssetForTest); err == nil {
			t.Fatal("manifest signed by an untrusted key was accepted")
		}
	})
	t.Run("other release version", func(t *testing.T) {
		m := signRecoveryManifest(t, "1.2.4", good)
		if _, err := m.updater.VerifiedReleaseAssetSHA256(m.payload, m.signature, m.keyID, "1.2.3", recoveryAssetForTest); err == nil || !strings.Contains(err.Error(), "version mismatch") {
			t.Fatalf("want version mismatch, got %v", err)
		}
	})
	t.Run("missing entry", func(t *testing.T) {
		m := signRecoveryManifest(t, "1.2.3", []releaseArtifactAsset{{Name: "breeze-agent-windows-amd64.exe", SHA256: sha}})
		if _, err := m.updater.VerifiedReleaseAssetSHA256(m.payload, m.signature, m.keyID, "1.2.3", recoveryAssetForTest); err == nil || !strings.Contains(err.Error(), "does not include") {
			t.Fatalf("want missing entry, got %v", err)
		}
	})
	t.Run("non-hex checksum", func(t *testing.T) {
		m := signRecoveryManifest(t, "1.2.3", []releaseArtifactAsset{{Name: recoveryAssetForTest, SHA256: strings.Repeat("zz", 32)}})
		if _, err := m.updater.VerifiedReleaseAssetSHA256(m.payload, m.signature, m.keyID, "1.2.3", recoveryAssetForTest); err == nil {
			t.Fatal("non-hex checksum accepted")
		}
	})
	t.Run("unknown edition", func(t *testing.T) {
		m := signRecoveryManifest(t, "1.2.3", []releaseArtifactAsset{{Name: recoveryAssetForTest, SHA256: sha, Edition: "future"}})
		if _, err := m.updater.VerifiedReleaseAssetSHA256(m.payload, m.signature, m.keyID, "1.2.3", recoveryAssetForTest); err == nil {
			t.Fatal("unknown edition accepted")
		}
	})
}
