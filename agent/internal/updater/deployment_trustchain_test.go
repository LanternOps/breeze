package updater

import (
	"encoding/json"
	"os"
	"runtime"
	"testing"
)

// deploymentManifestFixture mirrors the JSON written by
// scripts/generate-deployment-manifest-fixture.mjs. It is the Go end of the
// BYO-signing trust chain (spec 3b): the API re-signs a normalized update
// manifest with the per-deployment key; this test proves the shipped agent
// accepts EXACTLY those bytes under the deploy-* key ID — and only under it.
type deploymentManifestFixture struct {
	KeyID        string `json:"keyId"`
	PublicKeyB64 string `json:"publicKeyB64"`
	Entries      []struct {
		Platform     string `json:"platform"`
		Arch         string `json:"arch"`
		URL          string `json:"url"`
		Checksum     string `json:"checksum"`
		Manifest     string `json:"manifest"`
		SignatureB64 string `json:"signatureB64"`
	} `json:"entries"`
}

func loadDeploymentManifestFixture(t *testing.T) deploymentManifestFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/deployment_signed_manifest.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fx deploymentManifestFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return fx
}

func TestDeploymentSignedManifestFixture_VerifiesUnderPinnedDeploymentKey(t *testing.T) {
	fx := loadDeploymentManifestFixture(t)

	var entry *struct {
		Platform     string `json:"platform"`
		Arch         string `json:"arch"`
		URL          string `json:"url"`
		Checksum     string `json:"checksum"`
		Manifest     string `json:"manifest"`
		SignatureB64 string `json:"signatureB64"`
	}
	for i := range fx.Entries {
		if fx.Entries[i].Platform == manifestPlatform() && fx.Entries[i].Arch == runtime.GOARCH {
			entry = &fx.Entries[i]
			break
		}
	}
	if entry == nil {
		t.Skipf("fixture has no entry for %s/%s", manifestPlatform(), runtime.GOARCH)
	}

	u := &Updater{
		config: &Config{
			Component:             "agent",
			PinnedManifestPubKeys: []string{fx.KeyID + ":" + fx.PublicKeyB64},
		},
	}
	info := downloadInfo{
		URL:               entry.URL,
		Checksum:          entry.Checksum,
		Manifest:          entry.Manifest,
		ManifestSignature: entry.SignatureB64,
		SigningKeyID:      fx.KeyID,
	}
	got, err := u.verifyUpdateManifest(info, "9.9.9")
	if err != nil {
		t.Fatalf("verifyUpdateManifest: %v", err)
	}
	if got.Version != "9.9.9" || got.Component != "agent" {
		t.Fatalf("unexpected manifest accepted: %+v", got)
	}
}

func TestDeploymentSignedManifestFixture_RejectedUnderOfficialKeyID(t *testing.T) {
	// Keyed trust means the deployment signature must NOT verify when the
	// response claims the embedded official key's ID (P1-UPD-001 semantics).
	fx := loadDeploymentManifestFixture(t)
	entry := fx.Entries[0]

	u := &Updater{
		config: &Config{
			Component:             "agent",
			PinnedManifestPubKeys: []string{fx.KeyID + ":" + fx.PublicKeyB64},
		},
	}
	info := downloadInfo{
		URL:               entry.URL,
		Checksum:          entry.Checksum,
		Manifest:          entry.Manifest,
		ManifestSignature: entry.SignatureB64,
		SigningKeyID:      "release-artifact-manifest-ed25519",
	}
	if _, err := u.verifyUpdateManifest(info, "9.9.9"); err == nil {
		t.Fatal("expected verification to fail under the official key ID")
	}
}
