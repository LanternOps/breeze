package updater

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"runtime"
	"strings"
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

// deploymentFixtureSHA256 pins the exact bytes of the committed fixture.
//
// The fixture is the ONLY thing tying the API's re-signing output to what this
// agent accepts, and it is regenerable by script. Without this, the cheapest
// way to get a red trust-chain test green is to re-run the generator — which
// silently converts a broken trust chain into a two-file edit. The same
// constant is asserted on the TypeScript side, so a legitimate regeneration
// requires deliberately updating a hash in two languages.
//
// If you intentionally changed the fixture: re-run
//
//	node scripts/generate-deployment-manifest-fixture.mjs
//
// then update this constant AND the matching one in
// apps/api/src/services/releaseTrustChain.e2e.test.ts.
const deploymentFixtureSHA256 = "81cd0453706322c83fb127727745a6feecd130356944a1cd9c9aa141317a74bc"

func TestDeploymentSignedManifestFixture_BytesArePinned(t *testing.T) {
	raw, err := os.ReadFile("testdata/deployment_signed_manifest.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	sum := sha256.Sum256(raw)
	if got := hex.EncodeToString(sum[:]); got != deploymentFixtureSHA256 {
		t.Fatalf("fixture bytes changed:\n  got  %s\n  want %s\nRegenerating the fixture is not a fix for a failing trust-chain test — see the comment above.", got, deploymentFixtureSHA256)
	}
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
	//
	// With ONLY the deploy key pinned this fails at the key-ID map lookup and
	// never reaches ed25519.Verify — so it would still pass if the cross-key
	// fallback loop were reintroduced, i.e. the test would survive its own
	// regression. Install a REAL (decoy) embedded key under the official ID so
	// the lookup succeeds and the failure has to come from the signature check
	// itself. Pinning one under that ID is refused outright by the
	// shadow-protection in assembleManifestTrustKeys, which is why this goes
	// through the embedded map.
	fx := loadDeploymentManifestFixture(t)
	entry := fx.Entries[0]

	decoyPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate decoy key: %v", err)
	}
	installEmbeddedManifestKey(t, "release-artifact-manifest-ed25519", decoyPub)

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
	_, err = u.verifyUpdateManifest(info, "9.9.9")
	if err == nil {
		t.Fatal("expected verification to fail under the official key ID")
	}
	if !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("expected a SIGNATURE failure (proving no cross-key fallback), got: %v", err)
	}
}

// The acceptance test above proves the fixture verifies. These prove the
// verification is load-bearing: without them nothing distinguishes "the
// signature was checked" from "the code path happened to return nil".
func TestDeploymentSignedManifestFixture_TamperedInputsRejected(t *testing.T) {
	fx := loadDeploymentManifestFixture(t)
	entry := fx.Entries[0]

	base := downloadInfo{
		URL:               entry.URL,
		Checksum:          entry.Checksum,
		Manifest:          entry.Manifest,
		ManifestSignature: entry.SignatureB64,
		SigningKeyID:      fx.KeyID,
	}

	sigBytes, err := base64.StdEncoding.DecodeString(entry.SignatureB64)
	if err != nil {
		t.Fatalf("decode fixture signature: %v", err)
	}
	flipped := make([]byte, len(sigBytes))
	copy(flipped, sigBytes)
	flipped[0] ^= 0xFF

	cases := []struct {
		name   string
		mutate func(d *downloadInfo)
	}{
		{"manifest byte changed", func(d *downloadInfo) {
			d.Manifest = strings.Replace(d.Manifest, `"agent"`, `"watchdog"`, 1)
		}},
		{"signature bit flipped", func(d *downloadInfo) {
			d.ManifestSignature = base64.StdEncoding.EncodeToString(flipped)
		}},
		{"signature truncated", func(d *downloadInfo) {
			d.ManifestSignature = base64.StdEncoding.EncodeToString(sigBytes[:len(sigBytes)-1])
		}},
		{"signature not base64", func(d *downloadInfo) {
			d.ManifestSignature = "!!!not-base64!!!"
		}},
		{"signature empty", func(d *downloadInfo) {
			d.ManifestSignature = ""
		}},
		{"checksum does not match the signed manifest", func(d *downloadInfo) {
			d.Checksum = strings.Repeat("0", len(entry.Checksum))
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u := &Updater{
				config: &Config{
					Component:             "agent",
					PinnedManifestPubKeys: []string{fx.KeyID + ":" + fx.PublicKeyB64},
				},
			}
			info := base
			tc.mutate(&info)
			if _, err := u.verifyUpdateManifest(info, "9.9.9"); err == nil {
				t.Fatalf("expected rejection for %q", tc.name)
			}
		})
	}
}

// The vitest side asserts only linux/amd64 and the acceptance test above skips
// unless an entry matches the host, so on any single CI runner most of the
// fixture went unchecked. Verify every entry's signature directly — that part
// is platform-independent.
func TestDeploymentSignedManifestFixture_AllEntriesVerify(t *testing.T) {
	fx := loadDeploymentManifestFixture(t)
	if len(fx.Entries) == 0 {
		t.Fatal("fixture has no entries")
	}

	u := &Updater{
		config: &Config{
			Component:             "agent",
			PinnedManifestPubKeys: []string{fx.KeyID + ":" + fx.PublicKeyB64},
		},
	}
	for _, entry := range fx.Entries {
		name := entry.Platform + "/" + entry.Arch
		t.Run(name, func(t *testing.T) {
			// verifyManifestSignature takes the RAW signature bytes.
			sig, err := base64.StdEncoding.DecodeString(entry.SignatureB64)
			if err != nil {
				t.Fatalf("decode signature for %s: %v", name, err)
			}
			if err := u.verifyManifestSignature([]byte(entry.Manifest), sig, fx.KeyID); err != nil {
				t.Fatalf("signature did not verify for %s: %v", name, err)
			}
		})
	}
}
