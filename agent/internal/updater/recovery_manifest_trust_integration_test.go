package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
)

// End to end: real Ed25519 signing, the envelope persisted exactly as the
// server's download info serves it, and recoveryinstall.TrustPolicy with
// Path B bound to VerifiedReleaseAssetSHA256. This is the production pairing
// the isolation packages cannot import themselves.
func TestRecoveryTrustPolicyWithRealSignedManifest(t *testing.T) {
	exe := []byte("unsigned self-host recovery 1.2.3")
	sum := sha256.Sum256(exe)
	exeSHA := hex.EncodeToString(sum[:])
	assets := []releaseArtifactAsset{{Name: recoveryAssetForTest, SHA256: exeSHA, Size: int64(len(exe)), Edition: "self-host"}}

	for _, tc := range []struct {
		name    string
		release string
		dirVer  string
		mutate  func(info *downloadInfo, exePath string)
		trusted bool
	}{
		{name: "matching signed entry", release: "v1.2.3", dirVer: "1.2.3", trusted: true},
		{name: "manifest for another release", release: "1.2.4", dirVer: "1.2.3"},
		{name: "exe moved under another version dir", release: "1.2.3", dirVer: "1.2.4"},
		{name: "signature stripped", release: "1.2.3", dirVer: "1.2.3", mutate: func(info *downloadInfo, _ string) { info.ManifestSignature = "" }},
		{name: "payload edited after signing", release: "1.2.3", dirVer: "1.2.3", mutate: func(info *downloadInfo, _ string) {
			info.Manifest = info.Manifest[:len(info.Manifest)-1] + " }"
		}},
		{name: "exe replaced after install", release: "1.2.3", dirVer: "1.2.3", mutate: func(_ *downloadInfo, exePath string) {
			if err := os.WriteFile(exePath, []byte("attacker payload"), 0o700); err != nil {
				panic(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := signRecoveryManifest(t, tc.release, assets)
			dir := filepath.Join(t.TempDir(), "Breeze", recoveryinstall.RecoveryDirName, tc.dirVer)
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			exePath := filepath.Join(dir, "breeze-isolation-recovery.exe")
			if err := os.WriteFile(exePath, exe, 0o700); err != nil {
				t.Fatal(err)
			}
			// Persist the envelope as served (downloadInfo's own JSON tags), so a
			// tag drift between the updater and ManifestEnvelope fails here.
			info := downloadInfo{Manifest: m.payload, ManifestSignature: m.signature, SigningKeyID: m.keyID}
			if tc.mutate != nil {
				tc.mutate(&info, exePath)
			}
			data, err := json.Marshal(info)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, recoveryinstall.ManifestEnvelopeName), data, 0o600); err != nil {
				t.Fatal(err)
			}
			policy := recoveryinstall.TrustPolicy{
				CodeSignature: func(string) error { return errors.New("not Authenticode signed") },
				ManifestTrust: recoveryinstall.ManifestTrust{
					SelfHostEdition: true,
					AssetName:       recoveryAssetForTest,
					ManifestDigest: func(env recoveryinstall.ManifestEnvelope, version, asset string) (string, error) {
						return m.updater.VerifiedReleaseAssetSHA256(env.Manifest, env.Signature, env.SigningKeyID, version, asset)
					},
				},
			}
			got, err := policy.Verify(exePath)
			if tc.trusted {
				if err != nil || got != recoveryinstall.TrustManifestHash {
					t.Fatalf("got %q, %v", got, err)
				}
				return
			}
			if !errors.Is(err, recoveryinstall.ErrUntrusted) || got != "" {
				t.Fatalf("want ErrUntrusted, got %q, %v", got, err)
			}
		})
	}
}
