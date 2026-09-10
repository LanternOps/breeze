package agentapp

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type signedInstallFixture struct {
	server               *httptest.Server
	client               *http.Client
	keys                 map[string]ed25519.PublicKey
	manifest, sig, asset string
}

func newSignedInstallFixture(t *testing.T, component, goos, goarch, version string, body []byte, mutate func(*firstInstallManifest)) signedInstallFixture {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	name, err := firstInstallAssetName(component, goos, goarch)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	m := firstInstallManifest{
		SchemaVersion: 1, Repository: firstInstallRepository, Release: "v" + version,
		SourceCommit: strings.Repeat("a", 40),
		Assets:       []firstInstallManifestAsset{{Name: name, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(body)), PlatformTrust: expectedFirstInstallPlatformTrust(goos), Edition: "self-host"}},
	}
	if mutate != nil {
		mutate(&m)
	}
	payload, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload)) + "\n"
	mux := http.NewServeMux()
	mux.HandleFunc("/manifest", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(payload) })
	mux.HandleFunc("/signature", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(signature)) })
	mux.HandleFunc("/asset", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) })
	srv := httptest.NewServer(mux)
	return signedInstallFixture{srv, srv.Client(), map[string]ed25519.PublicKey{"fixture": pub}, srv.URL + "/manifest", srv.URL + "/signature", srv.URL + "/asset"}
}

func (f signedInstallFixture) close() { f.server.Close() }

func TestVerifyFirstInstallManifest_BindsCompleteTuple(t *testing.T) {
	body := writeLargeBody(31)
	tests := []struct {
		name   string
		mutate func(*firstInstallManifest)
	}{
		{"wrong repository", func(m *firstInstallManifest) { m.Repository = "other/repo" }},
		{"wrong release", func(m *firstInstallManifest) { m.Release = "v9.9.9" }},
		{"missing source lineage", func(m *firstInstallManifest) { m.SourceCommit = "" }},
		{"wrong component platform asset", func(m *firstInstallManifest) { m.Assets[0].Name = "breeze-watchdog-windows-amd64.exe" }},
		{"duplicate asset", func(m *firstInstallManifest) { m.Assets = append(m.Assets, m.Assets[0]) }},
		{"wrong size", func(m *firstInstallManifest) { m.Assets[0].Size++ }},
		{"wrong digest", func(m *firstInstallManifest) { m.Assets[0].SHA256 = strings.Repeat("0", 64) }},
		{"wrong trust", func(m *firstInstallManifest) { m.Assets[0].PlatformTrust = "none" }},
		{"wrong edition", func(m *firstInstallManifest) { m.Assets[0].Edition = "enterprise" }},
		{"signing input", func(m *firstInstallManifest) { m.Assets[0].IntendedUse = "signing-input" }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fx := newSignedInstallFixture(t, "watchdog", "linux", "amd64", "1.2.3", body, tc.mutate)
			defer fx.close()
			err := stageFirstInstallArtifact(firstInstallArtifactSpec{component: "watchdog", version: "1.2.3", goos: "linux", goarch: "amd64", assetURL: fx.asset, manifestURL: fx.manifest, signatureURL: fx.sig, destPath: filepath.Join(t.TempDir(), "watchdog"), client: fx.client, trustKeys: fx.keys})
			if err == nil {
				t.Fatal("mismatched signed tuple was accepted")
			}
		})
	}
}

func TestStageFirstInstallArtifact_RejectsUnsignedOrAlteredBytes(t *testing.T) {
	body := writeLargeBody(32)
	fx := newSignedInstallFixture(t, "desktop-helper", "darwin", "arm64", "1.2.3", body, nil)
	defer fx.close()
	tests := []struct{ name, sigURL, assetURL string }{{"missing signature", fx.server.URL + "/missing", fx.asset}, {"altered artifact", fx.sig, fx.server.URL + "/manifest"}}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "helper")
			err := stageFirstInstallArtifact(firstInstallArtifactSpec{component: "desktop-helper", version: "1.2.3", goos: "darwin", goarch: "arm64", assetURL: tc.assetURL, manifestURL: fx.manifest, signatureURL: tc.sigURL, destPath: dest, client: fx.client, trustKeys: fx.keys})
			if err == nil {
				t.Fatal("unauthorized artifact was staged")
			}
			if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
				t.Fatalf("destination exists after rejection: %v", statErr)
			}
		})
	}
}

func TestBootstrapWatchdog_VerifiesAndUsesInjectedRunner(t *testing.T) {
	body := writeLargeBody(33)
	fx := newSignedInstallFixture(t, "watchdog", "linux", "amd64", "1.2.3", body, nil)
	defer fx.close()
	dir := t.TempDir()
	agent := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agent, []byte("agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	called := false
	err := bootstrapWatchdog(bootstrapOptions{agentPath: agent, version: "1.2.3", goos: "linux", goarch: "amd64", urlOverride: fx.asset, manifestURLOverride: fx.manifest, signatureURLOverride: fx.sig, clientOverride: fx.client, trustKeysOverride: fx.keys, runInstaller: func(path string) error {
		called = true
		got, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if string(got) != string(body) {
			t.Fatal("runner did not receive verified bytes")
		}
		if filepath.Dir(path) == dir {
			t.Fatal("watchdog executed from caller-controlled source directory")
		}
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("injected runner was not called")
	}
}

func TestBootstrapWatchdog_AcceptsOnlyExplicitlyProtectedPackagedSiblingWithoutNetwork(t *testing.T) {
	body := writeLargeBody(36)
	dir := t.TempDir()
	agent := filepath.Join(dir, "breeze-agent")
	sibling := filepath.Join(dir, watchdogBinaryName("linux"))
	if err := os.WriteFile(agent, []byte("agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sibling, body, 0o755); err != nil {
		t.Fatal(err)
	}
	called := false
	err := bootstrapWatchdog(bootstrapOptions{
		agentPath: agent, version: "1.2.3", goos: "linux", goarch: "amd64",
		protectedSiblingOverride: func(gotAgent, gotSibling string) bool {
			return gotAgent == agent && gotSibling == sibling
		},
		runInstaller: func(path string) error {
			called = true
			got, readErr := os.ReadFile(path)
			if readErr != nil || string(got) != string(body) {
				t.Fatalf("protected packaged sibling was not staged exactly: %v", readErr)
			}
			if filepath.Dir(path) == dir {
				t.Fatal("packaged watchdog executed from its source path")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("protected packaged watchdog was not invoked")
	}
}

func TestStageDesktopHelper_VerifiesSiblingBeforeCopy(t *testing.T) {
	body := writeLargeBody(34)
	fx := newSignedInstallFixture(t, "desktop-helper", "darwin", "arm64", "1.2.3", body, nil)
	defer fx.close()
	dir := t.TempDir()
	agent := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agent, []byte("agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, desktopHelperBinaryName), body, 0o755); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), desktopHelperBinaryName)
	err := stageDesktopHelper(desktopHelperStageOptions{agentPath: agent, destPath: dest, version: "1.2.3", goos: "darwin", goarch: "arm64", manifestURLOverride: fx.manifest, signatureURLOverride: fx.sig, clientOverride: fx.client, trustKeysOverride: fx.keys})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != string(body) {
		t.Fatalf("verified sibling was not installed: %v", err)
	}
}

func TestStageDesktopHelper_AcceptsOnlyExplicitlyProtectedPackagedSiblingWithoutNetwork(t *testing.T) {
	body := writeLargeBody(37)
	dir := t.TempDir()
	agent := filepath.Join(dir, "breeze-agent")
	sibling := filepath.Join(dir, desktopHelperBinaryName)
	if err := os.WriteFile(agent, []byte("agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sibling, body, 0o755); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), desktopHelperBinaryName)
	err := stageDesktopHelper(desktopHelperStageOptions{
		agentPath: agent, destPath: dest, version: "1.2.3", goos: "darwin", goarch: "arm64",
		protectedSiblingOverride: func(gotAgent, gotSibling string) bool {
			return gotAgent == agent && gotSibling == sibling
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != string(body) {
		t.Fatalf("protected packaged desktop helper was not copied exactly: %v", err)
	}
}

func TestFirstInstallTrustKeys_AcceptsKeyedBYOAndRejectsShadowing(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS", "site-key:"+base64.StdEncoding.EncodeToString(pub))
	keys, err := firstInstallTrustKeys()
	if err != nil {
		t.Fatal(err)
	}
	if !keys["site-key"].Equal(pub) {
		t.Fatal("BYO key was not loaded under its exact ID")
	}
	other, _, _ := ed25519.GenerateKey(nil)
	t.Setenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS", firstInstallManifestKeyID+":"+base64.StdEncoding.EncodeToString(other))
	if _, err := firstInstallTrustKeys(); err == nil {
		t.Fatal("BYO key shadowed embedded official key ID")
	}
}

func TestFirstInstallBYORepositoryIsExplicitlyBound(t *testing.T) {
	t.Setenv("BINARY_GITHUB_REPOSITORY", "customer/signed-breeze")
	body := writeLargeBody(35)
	fx := newSignedInstallFixture(t, "watchdog", "linux", "amd64", "1.2.3", body, func(m *firstInstallManifest) {
		m.Repository = "customer/signed-breeze"
	})
	defer fx.close()
	dest := filepath.Join(t.TempDir(), "watchdog")
	err := stageFirstInstallArtifact(firstInstallArtifactSpec{component: "watchdog", version: "1.2.3", goos: "linux", goarch: "amd64", assetURL: fx.asset, manifestURL: fx.manifest, signatureURL: fx.sig, destPath: dest, client: fx.client, trustKeys: fx.keys})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(watchdogDownloadURL("1.2.3", "linux", "amd64"), "github.com/customer/signed-breeze/releases/download") {
		t.Fatal("BYO repository did not control the release source URL")
	}
}

func TestFirstInstallEmbeddedTrustRootMatchesRepositoryKey(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test file")
	}
	pemBytes, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "internal", "release-keys", "release-manifest.ed25519.pub"))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		t.Fatal("release manifest public key is not PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	want, ok := parsed.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("repository key has type %T", parsed)
	}
	keys, err := firstInstallTrustKeys()
	if err != nil {
		t.Fatal(err)
	}
	if !keys[firstInstallManifestKeyID].Equal(want) {
		t.Fatal("first-install embedded trust root drifted from repository key")
	}
}

func TestFirstInstallAssetName_BindsSupportedPlatformTuple(t *testing.T) {
	tests := []struct{ component, goos, goarch, want string }{
		{"watchdog", "windows", "amd64", "breeze-watchdog-windows-amd64.exe"},
		{"watchdog", "linux", "arm64", "breeze-watchdog-linux-arm64"},
		{"watchdog", "darwin", "amd64", "breeze-watchdog-darwin-amd64"},
		{"desktop-helper", "darwin", "arm64", "breeze-desktop-helper-darwin-arm64"},
	}
	for _, tc := range tests {
		t.Run(tc.component+"/"+tc.goos+"/"+tc.goarch, func(t *testing.T) {
			got, err := firstInstallAssetName(tc.component, tc.goos, tc.goarch)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}
