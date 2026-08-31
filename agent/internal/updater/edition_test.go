package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// Edition-aware update manifest enforcement (backward-compatible).
//
// Release-artifact manifests carry an optional per-asset "edition" field
// ("self-host" | "hosted"). The updater must refuse to apply an asset whose
// declared edition does not match the running build's own edition family,
// while treating an ABSENT field as acceptable — both because manifests
// predating the field must keep working, and because an old agent (built
// before this check existed) never consults the field at all, so it can
// still upgrade cleanly into an edition-stamped manifest.

// signedReleaseArtifactDownloadInfoWithEdition mirrors
// signedReleaseArtifactDownloadInfo (updater_test.go) but stamps the single
// asset entry with an explicit edition, using the real production
// releaseArtifactManifest/releaseArtifactAsset types so the JSON tag names
// are pinned by the compiler rather than hand-duplicated.
func signedReleaseArtifactDownloadInfoWithEdition(t *testing.T, version, assetName, edition, rawURL string, content []byte) downloadInfo {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, publicKey)

	sum := sha256.Sum256(content)
	checksum := hex.EncodeToString(sum[:])
	manifest := releaseArtifactManifest{
		SchemaVersion: 1,
		Release:       "v" + version,
		Assets: []releaseArtifactAsset{
			{Name: assetName, SHA256: checksum, Size: int64(len(content)), Edition: edition},
		},
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, payload)
	return downloadInfo{
		URL:               rawURL,
		Checksum:          checksum,
		Manifest:          string(payload),
		ManifestSignature: base64.StdEncoding.EncodeToString(signature),
		SigningKeyID:      testEmbeddedKeyID,
	}
}

func agentAssetName() string {
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	return "breeze-agent-" + runtime.GOOS + "-" + runtime.GOARCH + suffix
}

// --- editionAllowed: pure helper -------------------------------------------------

func TestEditionAllowed_AbsentAcceptedInSelfHost(t *testing.T) {
	// repo-default build: hostpolicy.Enforced() == false
	if !editionAllowed("") {
		t.Fatal("absent edition must be accepted in self-host build")
	}
}

func TestEditionAllowed_AbsentAcceptedInHosted(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	if !editionAllowed("") {
		t.Fatal("absent edition must be accepted in hosted build")
	}
}

func TestEditionAllowed_SelfHostAcceptedInSelfHostBuild(t *testing.T) {
	if !editionAllowed("self-host") {
		t.Fatal("edition=self-host must be accepted in a self-host build")
	}
}

func TestEditionAllowed_SelfHostRejectedInHostedBuild(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	if editionAllowed("self-host") {
		t.Fatal("edition=self-host must be rejected in a hosted build")
	}
}

func TestEditionAllowed_HostedAcceptedInSelfHostBuild(t *testing.T) {
	// One-way self-host → hosted transition (#4072). Both call sites only
	// consult editionAllowed AFTER the manifest's Ed25519 signature verified
	// against the trust roots, and moving onto a hosted build only ADDS
	// enforcement (the hostpolicy allowlist) — so a self-host build accepts
	// a hosted-edition artifact rather than wedging in a permanent refusal
	// loop the moment its control plane cuts over to hosted artifacts.
	if !editionAllowed("hosted") {
		t.Fatal("edition=hosted must be accepted in a self-host build (one-way transition, #4072)")
	}
}

func TestEditionAllowed_HostedAcceptedInHostedBuild(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	if !editionAllowed("hosted") {
		t.Fatal("edition=hosted must be accepted in a hosted build")
	}
}

func TestEditionAllowed_UnknownValueRejectedRegardlessOfBuildMode(t *testing.T) {
	if editionAllowed("enterprise") {
		t.Fatal("unrecognized edition must be rejected in self-host build")
	}
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	if editionAllowed("enterprise") {
		t.Fatal("unrecognized edition must be rejected in hosted build")
	}
}

// --- primary manifest-verified path: verifyReleaseArtifactManifest ---------------

func TestVerifyUpdateManifest_ReleaseArtifact_EditionAbsent_AcceptedSelfHost(t *testing.T) {
	assetName := agentAssetName()
	content := []byte("fake binary edition-absent self-host")
	info := signedReleaseArtifactDownloadInfoWithEdition(t, "1.0.0", assetName, "", "http://example/"+assetName, content)

	u := &Updater{config: &Config{Component: "agent"}}
	if _, err := u.verifyUpdateManifest(info, "1.0.0"); err != nil {
		t.Fatalf("absent edition must be accepted in self-host build: %v", err)
	}
}

func TestVerifyUpdateManifest_ReleaseArtifact_EditionAbsent_AcceptedHosted(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	assetName := agentAssetName()
	content := []byte("fake binary edition-absent hosted")
	info := signedReleaseArtifactDownloadInfoWithEdition(t, "1.0.0", assetName, "", "http://example/"+assetName, content)

	u := &Updater{config: &Config{Component: "agent"}}
	if _, err := u.verifyUpdateManifest(info, "1.0.0"); err != nil {
		t.Fatalf("absent edition must be accepted in hosted build: %v", err)
	}
}

func TestVerifyUpdateManifest_ReleaseArtifact_SelfHostEdition_AcceptedInSelfHostBuild(t *testing.T) {
	assetName := agentAssetName()
	content := []byte("fake binary edition self-host")
	info := signedReleaseArtifactDownloadInfoWithEdition(t, "1.0.0", assetName, "self-host", "http://example/"+assetName, content)

	u := &Updater{config: &Config{Component: "agent"}}
	if _, err := u.verifyUpdateManifest(info, "1.0.0"); err != nil {
		t.Fatalf("edition=self-host must be accepted in a self-host build: %v", err)
	}
}

func TestVerifyUpdateManifest_ReleaseArtifact_SelfHostEdition_RejectedInHostedBuild(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	assetName := agentAssetName()
	content := []byte("fake binary edition self-host")
	info := signedReleaseArtifactDownloadInfoWithEdition(t, "1.0.0", assetName, "self-host", "http://example/"+assetName, content)

	u := &Updater{config: &Config{Component: "agent"}}
	if _, err := u.verifyUpdateManifest(info, "1.0.0"); err == nil {
		t.Fatal("edition=self-host must be rejected in a hosted build")
	}
}

func TestVerifyUpdateManifest_ReleaseArtifact_HostedEdition_AcceptedInSelfHostBuild(t *testing.T) {
	assetName := agentAssetName()
	content := []byte("fake binary edition hosted")
	info := signedReleaseArtifactDownloadInfoWithEdition(t, "1.0.0", assetName, "hosted", "http://example/"+assetName, content)

	u := &Updater{config: &Config{Component: "agent"}}
	if _, err := u.verifyUpdateManifest(info, "1.0.0"); err != nil {
		t.Fatalf("edition=hosted must be accepted in a self-host build (one-way transition, #4072): %v", err)
	}
}

func TestVerifyUpdateManifest_ReleaseArtifact_HostedEdition_AcceptedInHostedBuild(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	assetName := agentAssetName()
	content := []byte("fake binary edition hosted")
	info := signedReleaseArtifactDownloadInfoWithEdition(t, "1.0.0", assetName, "hosted", "http://example/"+assetName, content)

	u := &Updater{config: &Config{Component: "agent"}}
	if _, err := u.verifyUpdateManifest(info, "1.0.0"); err != nil {
		t.Fatalf("edition=hosted must be accepted in a hosted build: %v", err)
	}
}

// --- fallback path that still consults manifest asset entries: pkgAssetChecksum --

func TestPkgAssetChecksum_EditionAbsent_AcceptedSelfHost(t *testing.T) {
	pkgName := "breeze-agent-darwin-" + runtime.GOARCH + ".pkg"
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: pkgName, SHA256: strings.Repeat("a", 64), Size: 20},
	})
	if _, err := pkgAssetChecksum(payload, "1.2.3"); err != nil {
		t.Fatalf("absent edition must be accepted in self-host build: %v", err)
	}
}

func TestPkgAssetChecksum_EditionAbsent_AcceptedHosted(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	pkgName := "breeze-agent-darwin-" + runtime.GOARCH + ".pkg"
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: pkgName, SHA256: strings.Repeat("a", 64), Size: 20},
	})
	if _, err := pkgAssetChecksum(payload, "1.2.3"); err != nil {
		t.Fatalf("absent edition must be accepted in hosted build: %v", err)
	}
}

func TestPkgAssetChecksum_SelfHostEdition_AcceptedInSelfHostBuild(t *testing.T) {
	pkgName := "breeze-agent-darwin-" + runtime.GOARCH + ".pkg"
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: pkgName, SHA256: strings.Repeat("a", 64), Size: 20, Edition: "self-host"},
	})
	if _, err := pkgAssetChecksum(payload, "1.2.3"); err != nil {
		t.Fatalf("edition=self-host must be accepted in a self-host build: %v", err)
	}
}

func TestPkgAssetChecksum_SelfHostEdition_RejectedInHostedBuild(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	pkgName := "breeze-agent-darwin-" + runtime.GOARCH + ".pkg"
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: pkgName, SHA256: strings.Repeat("a", 64), Size: 20, Edition: "self-host"},
	})
	if _, err := pkgAssetChecksum(payload, "1.2.3"); err == nil {
		t.Fatal("edition=self-host must be rejected in a hosted build")
	}
}

func TestPkgAssetChecksum_HostedEdition_AcceptedInSelfHostBuild(t *testing.T) {
	pkgName := "breeze-agent-darwin-" + runtime.GOARCH + ".pkg"
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: pkgName, SHA256: strings.Repeat("a", 64), Size: 20, Edition: "hosted"},
	})
	if _, err := pkgAssetChecksum(payload, "1.2.3"); err != nil {
		t.Fatalf("edition=hosted must be accepted in a self-host build (one-way transition, #4072): %v", err)
	}
}

func TestPkgAssetChecksum_HostedEdition_AcceptedInHostedBuild(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	pkgName := "breeze-agent-darwin-" + runtime.GOARCH + ".pkg"
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{
		{Name: pkgName, SHA256: strings.Repeat("a", 64), Size: 20, Edition: "hosted"},
	})
	if _, err := pkgAssetChecksum(payload, "1.2.3"); err != nil {
		t.Fatalf("edition=hosted must be accepted in a hosted build: %v", err)
	}
}
