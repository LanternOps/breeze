package recoveryinstall

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// Defense in depth: a hosted (allowlist-enforced) build never takes Path B,
// even if the wiring passes SelfHostEdition: true by mistake, and the digest
// verifier is never even called.
func TestTrustPolicyManifestHashRefusedOnHostedBuild(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted.example")
	defer restore()
	exe := []byte("unsigned recovery executable 1.2.3")
	f := newTrustFixture(t, "1.2.3", signedEnvelope("1.2.3"))
	calls := 0
	policy := TrustPolicy{
		CodeSignature: func(string) error { return errUnsigned },
		ManifestTrust: ManifestTrust{SelfHostEdition: true, AssetName: testAsset, ManifestDigest: func(ManifestEnvelope, string, string) (string, error) {
			calls++
			return shaHex(exe), nil
		}},
	}
	if got, err := policy.Verify(f.path); !errors.Is(err, ErrUntrusted) || got != "" {
		t.Fatalf("hosted build accepted Path B: %q %v", got, err)
	}
	if calls != 0 {
		t.Fatalf("hosted build consulted the manifest %d times", calls)
	}
}

const testAsset = "breeze-isolation-recovery-windows-amd64.exe"

var errUnsigned = errors.New("WinVerifyTrust status 0x800b0100")

// fakeManifestDigest stands in for updater.VerifiedReleaseAssetSHA256: it
// "verifies" an envelope whose signature is "signed-by-trust-root" and returns
// the SHA-256 listed for asset at exactly release.
func fakeManifestDigest(release string, assets map[string]string) AssetDigestFunc {
	return func(env ManifestEnvelope, version, asset string) (string, error) {
		if env.Signature != "signed-by-trust-root" {
			return "", errors.New("release manifest signature verification failed")
		}
		if env.Manifest != "manifest:"+release {
			return "", errors.New("release manifest payload does not match signature")
		}
		if version != release {
			return "", errors.New("release artifact manifest version mismatch")
		}
		sha, ok := assets[asset]
		if !ok {
			return "", errors.New("release artifact manifest does not include " + asset)
		}
		return sha, nil
	}
}

type trustFixture struct {
	path, dir string
	exe       []byte
}

func newTrustFixture(t *testing.T, version string, envelope *ManifestEnvelope) trustFixture {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "Breeze", RecoveryDirName, version)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	exe := []byte("unsigned recovery executable " + version)
	path := filepath.Join(dir, "breeze-isolation-recovery.exe")
	if err := os.WriteFile(path, exe, 0o700); err != nil {
		t.Fatal(err)
	}
	if envelope != nil {
		data, err := json.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ManifestEnvelopeName), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return trustFixture{path: path, dir: dir, exe: exe}
}

func shaHex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func signedEnvelope(release string) *ManifestEnvelope {
	return &ManifestEnvelope{Manifest: "manifest:" + release, Signature: "signed-by-trust-root", SigningKeyID: "release-artifact-manifest-ed25519"}
}

func TestTrustPolicyVerify(t *testing.T) {
	const version = "1.2.3"
	exeHash := shaHex([]byte("unsigned recovery executable " + version))
	signed := func(string) error { return nil }
	unsigned := func(string) error { return errUnsigned }
	for _, tc := range []struct {
		name     string
		policy   func(sha string) TrustPolicy
		envelope *ManifestEnvelope
		dirVer   string
		mutate   func(t *testing.T, f trustFixture)
		want     TrustPath
		untrust  bool
	}{
		{
			name:   "A: signed exe on hosted edition",
			policy: func(string) TrustPolicy { return TrustPolicy{CodeSignature: signed} },
			want:   TrustCodeSignature,
		},
		{
			name: "A wins on self-host when the exe is signed",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: signed, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			want:     TrustCodeSignature,
		},
		{
			name: "B: unsigned exe, matching signed-manifest hash, self-host edition",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			want:     TrustManifestHash,
		},
		{
			name: "B: digest compare ignores hex case",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: strings.ToUpper(sha)}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			want:     TrustManifestHash,
		},
		{
			name: "hosted edition never consults the manifest",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: false, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			untrust:  true,
		},
		{
			name: "self-host without a manifest verifier",
			policy: func(string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			untrust:  true,
		},
		{
			name: "no code-signature verifier at all",
			policy: func(string) TrustPolicy {
				return TrustPolicy{ManifestTrust: ManifestTrust{SelfHostEdition: true, AssetName: testAsset, ManifestDigest: fakeManifestDigest(version, nil)}}
			},
			untrust: true,
		},
		{
			name: "hash mismatch",
			policy: func(string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: strings.Repeat("ab", 32)}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			untrust:  true,
		},
		{
			name: "manifest for another release",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest("1.2.4", map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			envelope: signedEnvelope("1.2.4"),
			untrust:  true,
		},
		{
			name: "exe placed under another version directory than its manifest",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			dirVer:   "1.2.4",
			untrust:  true,
		},
		{
			name: "unsigned manifest",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			envelope: &ManifestEnvelope{Manifest: "manifest:" + version, Signature: "forged"},
			untrust:  true,
		},
		{
			name: "missing manifest envelope",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			untrust: true,
		},
		{
			name: "missing recovery entry in the manifest",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{"breeze-agent-windows-amd64.exe": sha}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			untrust:  true,
		},
		{
			name: "malformed digest from the verifier",
			policy: func(string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: "not-hex"}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			untrust:  true,
		},
		{
			name: "tampered exe after install (hash drift)",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			mutate: func(t *testing.T, f trustFixture) {
				if err := os.WriteFile(f.path, append(f.exe, []byte("payload")...), 0o700); err != nil {
					t.Fatal(err)
				}
			},
			untrust: true,
		},
		{
			name: "corrupt manifest envelope",
			policy: func(sha string) TrustPolicy {
				return TrustPolicy{CodeSignature: unsigned, ManifestTrust: ManifestTrust{SelfHostEdition: true, ManifestDigest: fakeManifestDigest(version, map[string]string{testAsset: sha}), AssetName: testAsset}}
			},
			envelope: signedEnvelope(version),
			mutate: func(t *testing.T, f trustFixture) {
				if err := os.WriteFile(filepath.Join(f.dir, ManifestEnvelopeName), []byte("{not json"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			untrust: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dirVer := version
			if tc.dirVer != "" {
				dirVer = tc.dirVer
			}
			f := newTrustFixture(t, dirVer, tc.envelope)
			// The fixture names the exe after its directory; hash the bytes the
			// manifest is meant to describe (the version under test).
			if dirVer != version {
				if err := os.WriteFile(f.path, []byte("unsigned recovery executable "+version), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if tc.mutate != nil {
				tc.mutate(t, f)
			}
			got, err := tc.policy(exeHash).Verify(f.path)
			if tc.untrust {
				if !errors.Is(err, ErrUntrusted) || got != "" {
					t.Fatalf("want ErrUntrusted, got %q, %v", got, err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

// Path B binds the hash to the version directory the installer placed. A path
// outside <install>\isolation-recovery\<version>\ has no version to bind to.
func TestTrustPolicyManifestHashRequiresVersionedLayout(t *testing.T) {
	exe := []byte("unsigned")
	policy := TrustPolicy{
		CodeSignature: func(string) error { return errUnsigned },
		ManifestTrust: ManifestTrust{
			SelfHostEdition: true, AssetName: testAsset,
			ManifestDigest: func(ManifestEnvelope, string, string) (string, error) { return shaHex(exe), nil },
		},
	}
	for _, rel := range []string{
		filepath.Join("Breeze", "breeze-isolation-recovery.exe"),
		filepath.Join("Breeze", "other", "1.2.3", "breeze-isolation-recovery.exe"),
		filepath.Join("Breeze", RecoveryDirName, "not-a-version", "breeze-isolation-recovery.exe"),
	} {
		t.Run(rel, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), rel)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, exe, 0o700); err != nil {
				t.Fatal(err)
			}
			data, _ := json.Marshal(signedEnvelope("1.2.3"))
			if err := os.WriteFile(filepath.Join(filepath.Dir(path), ManifestEnvelopeName), data, 0o600); err != nil {
				t.Fatal(err)
			}
			if got, err := policy.Verify(path); !errors.Is(err, ErrUntrusted) {
				t.Fatalf("want ErrUntrusted, got %q, %v", got, err)
			}
		})
	}
}

func TestReleaseAssetName(t *testing.T) {
	if got := ReleaseAssetName("windows", "amd64"); got != testAsset {
		t.Fatalf("got %q", got)
	}
	if got := ReleaseAssetName("darwin", "arm64"); got != "breeze-isolation-recovery-darwin-arm64" {
		t.Fatalf("got %q", got)
	}
}
