package agentapp

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// hostedControlPlane is a stand-in for an enrolled Breeze control plane. It
// serves the public GET /api/v1/agent-versions/:version/download endpoint the
// updater already uses (#646), returning the hosted-edition signed release
// manifest bytes verbatim plus an absolute URL for the artifact itself.
type hostedControlPlane struct {
	server *httptest.Server
	keys   map[string]ed25519.PublicKey
	body   []byte

	mu            sync.Mutex
	requests      []string
	assetRequests int

	// status, when non-zero, is returned instead of the JSON body.
	status int
	// rawBody, when non-empty, is returned instead of the JSON body.
	rawBody string
}

// assetFetches returns how many times the artifact itself was downloaded.
func (cp *hostedControlPlane) assetFetches() int {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return cp.assetRequests
}

// seenRequests returns a copy of the recorded request lines. The handler runs
// on the server's own goroutine, so the slice needs a lock, not just -race luck.
func (cp *hostedControlPlane) seenRequests() []string {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]string(nil), cp.requests...)
}

type hostedControlPlaneOptions struct {
	component, goos, goarch, version string
	edition                          string
	repository                       string
	signingKeyID                     string
	mutate                           func(*firstInstallManifest)
	// omitSignature drops manifestSignature from the JSON response.
	omitSignature bool
	// omitURL drops the artifact url from the JSON response.
	omitURL bool
	// status, when non-zero, makes the endpoint answer with that status only.
	status int
	// rawBody, when non-empty, is returned instead of a JSON object.
	rawBody string
}

func newHostedControlPlane(t *testing.T, opts hostedControlPlaneOptions) *hostedControlPlane {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	name, err := firstInstallAssetName(opts.component, opts.goos, opts.goarch)
	if err != nil {
		t.Fatal(err)
	}
	body := writeLargeBody(77)
	sum := sha256.Sum256(body)
	edition := opts.edition
	if edition == "" {
		edition = "hosted"
	}
	repository := opts.repository
	if repository == "" {
		// A hosted control plane's manifest names the PRIVATE build repository,
		// which no shipped agent binary knows.
		repository = "LanternOps/breeze-hosted"
	}
	signingKeyID := opts.signingKeyID
	if signingKeyID == "" {
		signingKeyID = firstInstallManifestKeyID
	}
	m := firstInstallManifest{
		SchemaVersion: 1,
		Repository:    repository,
		Release:       "v" + opts.version,
		SourceCommit:  strings.Repeat("b", 40),
		Assets: []firstInstallManifestAsset{{
			Name:          name,
			SHA256:        hex.EncodeToString(sum[:]),
			Size:          int64(len(body)),
			PlatformTrust: expectedFirstInstallPlatformTrust(opts.goos),
			Edition:       edition,
		}},
	}
	if opts.mutate != nil {
		opts.mutate(&m)
	}
	payload, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))

	cp := &hostedControlPlane{
		keys:   map[string]ed25519.PublicKey{firstInstallManifestKeyID: pub},
		body:   body,
		status: opts.status, rawBody: opts.rawBody,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent-versions/", func(w http.ResponseWriter, r *http.Request) {
		cp.mu.Lock()
		cp.requests = append(cp.requests, r.URL.String())
		cp.mu.Unlock()
		if cp.status != 0 {
			http.Error(w, "nope", cp.status)
			return
		}
		if cp.rawBody != "" {
			_, _ = w.Write([]byte(cp.rawBody))
			return
		}
		resp := map[string]string{
			"url":               "http://" + r.Host + "/api/v1/agents/download/" + opts.component + "/" + opts.goos + "/" + opts.goarch,
			"checksum":          hex.EncodeToString(sum[:]),
			"manifest":          string(payload),
			"manifestSignature": signature,
			"signingKeyId":      signingKeyID,
		}
		if opts.omitSignature {
			delete(resp, "manifestSignature")
		}
		if opts.omitURL {
			delete(resp, "url")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	mux.HandleFunc("/api/v1/agents/download/", func(w http.ResponseWriter, _ *http.Request) {
		cp.mu.Lock()
		cp.assetRequests++
		cp.mu.Unlock()
		_, _ = w.Write(body)
	})
	cp.server = httptest.NewServer(mux)
	t.Cleanup(cp.server.Close)
	return cp
}

// hosted arms hostpolicy so the process behaves like a hosted build whose only
// allowed control plane is this test server.
func (cp *hostedControlPlane) hosted(t *testing.T) {
	t.Helper()
	parsed, err := url.Parse(cp.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(hostpolicy.SetAllowedHostsForTest(parsed.Hostname()))
}

func newAgentBinary(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(path, []byte("agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestBootstrapWatchdog_HostedStagesFromControlPlane is the #5899 regression.
// A hosted build must stage the watchdog from the hosted-edition manifest its
// own control plane serves. Before the fix it fetched the PUBLIC GitHub
// release, whose watchdog assets are all edition "self-host", so the hosted
// asset policy refused every CLI install on every OS.
func TestBootstrapWatchdog_HostedStagesFromControlPlane(t *testing.T) {
	cp := newHostedControlPlane(t, hostedControlPlaneOptions{
		component: "watchdog", goos: "linux", goarch: "amd64", version: "1.2.3",
	})
	cp.hosted(t)

	ran := ""
	err := bootstrapWatchdog(bootstrapOptions{
		agentPath:         newAgentBinary(t),
		version:           "1.2.3",
		goos:              "linux",
		goarch:            "amd64",
		serverURL:         cp.server.URL,
		clientOverride:    cp.server.Client(),
		trustKeysOverride: cp.keys,
		runInstaller: func(path string) error {
			ran = path
			got, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if string(got) != string(cp.body) {
				t.Fatal("installer did not receive the control-plane-verified bytes")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatalf("hosted bootstrapWatchdog: %v", err)
	}
	if ran == "" {
		t.Fatal("installer was never invoked")
	}
	seen := cp.seenRequests()
	if len(seen) != 1 {
		t.Fatalf("expected exactly one agent-versions request, got %v", seen)
	}
	for _, want := range []string{"/api/v1/agent-versions/1.2.3/download", "platform=linux", "arch=amd64", "component=watchdog"} {
		if !strings.Contains(seen[0], want) {
			t.Errorf("control-plane request %q missing %q", seen[0], want)
		}
	}
}

// The relaxation in the hosted path is EXACTLY one field: `repository`, which a
// shipped agent cannot know for a private hosted build. Everything else the
// self-host path binds must still bind.
func TestBootstrapWatchdog_HostedStillBindsThePolicy(t *testing.T) {
	cases := []struct {
		name string
		opts hostedControlPlaneOptions
	}{
		{"self-host edition refused under hosted policy", hostedControlPlaneOptions{edition: "self-host"}},
		{"unknown edition refused", hostedControlPlaneOptions{edition: "enterprise"}},
		{"wrong release tag", hostedControlPlaneOptions{mutate: func(m *firstInstallManifest) { m.Release = "v9.9.9" }}},
		{"wrong asset name", hostedControlPlaneOptions{mutate: func(m *firstInstallManifest) { m.Assets[0].Name = "breeze-watchdog-windows-amd64.exe" }}},
		{"wrong digest", hostedControlPlaneOptions{mutate: func(m *firstInstallManifest) { m.Assets[0].SHA256 = strings.Repeat("0", 64) }}},
		{"wrong platform trust", hostedControlPlaneOptions{mutate: func(m *firstInstallManifest) { m.Assets[0].PlatformTrust = "none" }}},
		{"signing-input asset", hostedControlPlaneOptions{mutate: func(m *firstInstallManifest) { m.Assets[0].IntendedUse = "signing-input" }}},
		{"missing source lineage", hostedControlPlaneOptions{mutate: func(m *firstInstallManifest) { m.SourceCommit = "" }}},
		{"unofficial signing key id", hostedControlPlaneOptions{signingKeyID: "deploy-acme-2026"}},
		{"no signature", hostedControlPlaneOptions{omitSignature: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := tc.opts
			opts.component, opts.goos, opts.goarch, opts.version = "watchdog", "linux", "amd64", "1.2.3"
			cp := newHostedControlPlane(t, opts)
			cp.hosted(t)
			err := bootstrapWatchdog(bootstrapOptions{
				agentPath: newAgentBinary(t), version: "1.2.3", goos: "linux", goarch: "amd64",
				serverURL: cp.server.URL, clientOverride: cp.server.Client(), trustKeysOverride: cp.keys,
				runInstaller: func(string) error { t.Fatal("installer must not run on a refused artifact"); return nil },
			})
			if err == nil {
				t.Fatal("hosted policy accepted an artifact it must refuse")
			}
			// Guard against a vacuous pass: the refusal must come from the
			// control-plane path, not from never having reached it.
			if seen := cp.seenRequests(); len(seen) != 1 {
				t.Fatalf("expected the control plane to be consulted once, got %v (error was %v)", seen, err)
			}
			if strings.Contains(err.Error(), "fetch release manifest") {
				t.Fatalf("refusal came from the GitHub fallback, not the control-plane policy check: %v", err)
			}
		})
	}
}

// A manifest signed by a key the build does not trust must be refused even when
// it comes from the enrolled control plane — the server is a distribution
// channel, never the trust root.
func TestBootstrapWatchdog_HostedRefusesUntrustedSignature(t *testing.T) {
	cp := newHostedControlPlane(t, hostedControlPlaneOptions{
		component: "watchdog", goos: "linux", goarch: "amd64", version: "1.2.3",
	})
	cp.hosted(t)
	other, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	err = bootstrapWatchdog(bootstrapOptions{
		agentPath: newAgentBinary(t), version: "1.2.3", goos: "linux", goarch: "amd64",
		serverURL: cp.server.URL, clientOverride: cp.server.Client(),
		trustKeysOverride: map[string]ed25519.PublicKey{firstInstallManifestKeyID: other},
		runInstaller:      func(string) error { t.Fatal("installer must not run"); return nil },
	})
	if err == nil {
		t.Fatal("a manifest signed by an untrusted key was accepted")
	}
}

// A hosted build must refuse a control-plane URL outside its compile-time
// allowlist rather than fetching a manifest from it.
func TestResolveFirstInstallServerURL_HostedRefusesForeignHost(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	if _, err := resolveFirstInstallServerURL("https://attacker.es"); err == nil {
		t.Fatal("foreign control-plane host was accepted")
	}
	got, err := resolveFirstInstallServerURL("https://hosted-a.example/")
	if err != nil {
		t.Fatalf("allowlisted host refused: %v", err)
	}
	if got != "https://hosted-a.example" {
		t.Errorf("resolveFirstInstallServerURL = %q, want %q", got, "https://hosted-a.example")
	}
	// A fresh install runs before `enroll`, so there is no persisted server URL
	// yet; a single-host hosted build falls back to its own allowlist.
	got, err = resolveFirstInstallServerURL("")
	if err != nil {
		t.Fatalf("unenrolled hosted fallback failed: %v", err)
	}
	if got != "https://hosted-a.example" {
		t.Errorf("unenrolled fallback = %q, want %q", got, "https://hosted-a.example")
	}
}

// Self-host behaviour must be untouched: no control-plane lookup, GitHub URLs
// unchanged, and the trusted-host set not widened by hostpolicy's
// allow-everything self-host semantics.
func TestSelfHostFirstInstallSourceIsUnchanged(t *testing.T) {
	if hostpolicy.Enforced() {
		t.Fatal("repo default must be self-host")
	}
	spec := firstInstallArtifactSpec{
		component: "watchdog", version: "1.2.3", goos: "linux", goarch: "amd64",
		serverURL: "https://selfhost.example",
	}
	if err := applyHostedFirstInstallSource(&spec); err != nil {
		t.Fatalf("self-host applyHostedFirstInstallSource: %v", err)
	}
	if spec.serverSourced || spec.manifestBytes != nil || spec.signatureBytes != nil {
		t.Fatal("self-host build must not source first-install artifacts from a control plane")
	}
	for _, host := range []string{"selfhost.example", "attacker.es"} {
		if trustedReleaseHost(host) {
			t.Errorf("self-host trustedReleaseHost(%q) = true, want false", host)
		}
	}
	if !trustedReleaseHost("github.com") {
		t.Error("github.com must stay trusted in self-host mode")
	}
}

func TestTrustedReleaseHost_HostedAddsOnlyTheAllowlist(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	if !trustedReleaseHost("hosted-a.example") {
		t.Error("hosted build must trust its own allowlisted control plane")
	}
	for _, host := range []string{"hosted-a.example.evil.com", "app.hosted-a.example", "attacker.es"} {
		if trustedReleaseHost(host) {
			t.Errorf("trustedReleaseHost(%q) = true, want false", host)
		}
	}
}

// The remediation text a failed bootstrap prints must not send a hosted
// operator to the public GitHub release: it carries no hosted-edition watchdog,
// so following it reproduces #5899 by hand.
func TestWatchdogManualDownloadURL_HostedPointsAtTheControlPlane(t *testing.T) {
	selfHost := watchdogManualDownloadURL("1.2.3", "windows", "amd64", "")
	if !strings.HasPrefix(selfHost, "https://github.com/"+firstInstallRepository) {
		t.Errorf("self-host hint = %q, want the public GitHub release", selfHost)
	}

	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	hosted := watchdogManualDownloadURL("1.2.3", "windows", "amd64", "https://hosted-a.example")
	want := "https://hosted-a.example/api/v1/agents/download/watchdog/windows/amd64"
	if hosted != want {
		t.Errorf("hosted hint = %q, want %q", hosted, want)
	}
	if strings.Contains(hosted, "github.com") {
		t.Error("hosted remediation must never point at the public GitHub release")
	}
}

// Fixture guard, NOT a regression test for the fix: this only asserts the stub
// control plane answers in the same shape apps/api's agent-versions route does,
// so the suite above cannot pass against a response the real server would never
// produce. It would pass with applyHostedFirstInstallSource deleted.
func TestHostedControlPlaneFixtureMatchesServerContract(t *testing.T) {
	cp := newHostedControlPlane(t, hostedControlPlaneOptions{
		component: "watchdog", goos: "linux", goarch: "amd64", version: "1.2.3",
	})
	resp, err := cp.server.Client().Get(fmt.Sprintf("%s/api/v1/agent-versions/1.2.3/download?platform=linux&arch=amd64&component=watchdog", cp.server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var info agentVersionDownloadInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	if info.URL == "" || info.Manifest == "" || info.ManifestSignature == "" || info.SigningKeyID == "" {
		t.Fatalf("fixture response does not match the agent-versions contract: %+v", info)
	}
}

// The macOS desktop helper shares the staging path, so it had the SAME #5899
// bug and gets the same fix. Without this test a dropped `serverURL:` line in
// desktop_helper_bootstrap.go would break only hosted macOS installs.
func TestStageDesktopHelper_HostedStagesFromControlPlane(t *testing.T) {
	cp := newHostedControlPlane(t, hostedControlPlaneOptions{
		component: "desktop-helper", goos: "darwin", goarch: "arm64", version: "1.2.3",
	})
	cp.hosted(t)

	dest := filepath.Join(t.TempDir(), desktopHelperBinaryName)
	err := stageDesktopHelper(desktopHelperStageOptions{
		agentPath: newAgentBinary(t), destPath: dest, version: "1.2.3",
		goos: "darwin", goarch: "arm64",
		serverURL: cp.server.URL, clientOverride: cp.server.Client(), trustKeysOverride: cp.keys,
	})
	if err != nil {
		t.Fatalf("hosted stageDesktopHelper: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(cp.body) {
		t.Fatal("staged helper is not the control-plane-verified artifact")
	}
	if seen := cp.seenRequests(); len(seen) != 1 || !strings.Contains(seen[0], "component=desktop-helper") {
		t.Fatalf("control plane was not asked for the desktop-helper component: %v", seen)
	}
}

func TestDesktopHelperManualDownloadURL_HostedPointsAtTheControlPlane(t *testing.T) {
	if got := desktopHelperManualDownloadURL("1.2.3", "darwin", "arm64", ""); !strings.HasPrefix(got, "https://github.com/"+firstInstallRepository) {
		t.Errorf("self-host hint = %q, want the public GitHub release", got)
	}
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	got := desktopHelperManualDownloadURL("1.2.3", "darwin", "arm64", "https://hosted-a.example")
	want := "https://hosted-a.example/api/v1/agents/download/helper/darwin/arm64"
	if got != want {
		t.Errorf("hosted hint = %q, want %q", got, want)
	}
}

// A hosted host that already has an unprotected sibling watchdog must verify
// those LOCAL bytes against the control plane's hosted manifest — the manifest
// moves, the artifact source does not. A regression that also overwrote
// assetURL would turn an offline/sibling install into a network fetch.
func TestBootstrapWatchdog_HostedSiblingVerifiedAgainstControlPlaneManifest(t *testing.T) {
	cp := newHostedControlPlane(t, hostedControlPlaneOptions{
		component: "watchdog", goos: "linux", goarch: "amd64", version: "1.2.3",
	})
	cp.hosted(t)

	agentPath := newAgentBinary(t)
	sibling := filepath.Join(filepath.Dir(agentPath), watchdogBinaryName("linux"))
	if err := os.WriteFile(sibling, cp.body, 0o755); err != nil {
		t.Fatal(err)
	}
	staged := false
	err := bootstrapWatchdog(bootstrapOptions{
		agentPath: agentPath, version: "1.2.3", goos: "linux", goarch: "amd64",
		serverURL: cp.server.URL, clientOverride: cp.server.Client(), trustKeysOverride: cp.keys,
		// Not an OS-package-protected sibling: the bytes must be verified, not trusted.
		protectedSiblingOverride: func(string, string) bool { return false },
		runInstaller: func(path string) error {
			staged = true
			got, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if string(got) != string(cp.body) {
				t.Fatal("installer did not receive the sibling bytes")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatalf("hosted sibling bootstrap: %v", err)
	}
	if !staged {
		t.Fatal("installer was never invoked")
	}
	if seen := cp.seenRequests(); len(seen) != 1 {
		t.Fatalf("expected the hosted manifest to be fetched once, got %v", seen)
	}
	if n := cp.assetFetches(); n != 0 {
		t.Fatalf("a local sibling must not be re-downloaded, got %d asset fetches", n)
	}
}

// A sibling whose bytes do NOT match the hosted manifest is refused, so the
// manifest move cannot be mistaken for "trust whatever is on disk".
func TestBootstrapWatchdog_HostedSiblingWithWrongBytesIsRefused(t *testing.T) {
	cp := newHostedControlPlane(t, hostedControlPlaneOptions{
		component: "watchdog", goos: "linux", goarch: "amd64", version: "1.2.3",
	})
	cp.hosted(t)

	agentPath := newAgentBinary(t)
	sibling := filepath.Join(filepath.Dir(agentPath), watchdogBinaryName("linux"))
	if err := os.WriteFile(sibling, writeLargeBody(9), 0o755); err != nil {
		t.Fatal(err)
	}
	err := bootstrapWatchdog(bootstrapOptions{
		agentPath: agentPath, version: "1.2.3", goos: "linux", goarch: "amd64",
		serverURL: cp.server.URL, clientOverride: cp.server.Client(), trustKeysOverride: cp.keys,
		protectedSiblingOverride: func(string, string) bool { return false },
		runInstaller:             func(string) error { t.Fatal("installer must not run"); return nil },
	})
	if err == nil {
		t.Fatal("a sibling that does not match the signed manifest was staged")
	}
}

// Whatever the control plane answers with — a status code, a truncated body,
// an object missing a required field — must become a clean, specific error, not
// a panic and not a silent fallback to the public GitHub release.
func TestBootstrapWatchdog_HostedRefusesMalformedControlPlaneResponses(t *testing.T) {
	cases := []struct {
		name string
		opts hostedControlPlaneOptions
		want string
	}{
		{"not found", hostedControlPlaneOptions{status: http.StatusNotFound}, "status 404"},
		{"server error", hostedControlPlaneOptions{status: http.StatusInternalServerError}, "status 500"},
		{"not json", hostedControlPlaneOptions{rawBody: "<html>proxy error</html>"}, "invalid JSON"},
		{"empty object", hostedControlPlaneOptions{rawBody: "{}"}, "no signed release manifest"},
		{"no artifact url", hostedControlPlaneOptions{omitURL: true}, "no artifact URL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := tc.opts
			opts.component, opts.goos, opts.goarch, opts.version = "watchdog", "linux", "amd64", "1.2.3"
			cp := newHostedControlPlane(t, opts)
			cp.hosted(t)
			err := bootstrapWatchdog(bootstrapOptions{
				agentPath: newAgentBinary(t), version: "1.2.3", goos: "linux", goarch: "amd64",
				serverURL: cp.server.URL, clientOverride: cp.server.Client(), trustKeysOverride: cp.keys,
				runInstaller: func(string) error { t.Fatal("installer must not run"); return nil },
			})
			if err == nil {
				t.Fatal("a malformed control-plane response was accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not name the cause %q", err, tc.want)
			}
			if n := cp.assetFetches(); n != 0 {
				t.Errorf("artifact was fetched despite a bad metadata response (%d times)", n)
			}
		})
	}
}

// A hosted build whose allowlist names several control planes must refuse to
// pick one before enrollment rather than guessing a region.
func TestResolveFirstInstallServerURL_MultiHostUnenrolledRefusesToGuess(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example,hosted-b.example")
	defer restore()

	got, err := resolveFirstInstallServerURL("")
	if err == nil {
		t.Fatalf("a multi-region build guessed %q instead of refusing", got)
	}
	for _, want := range []string{"hosted-a.example", "hosted-b.example", "enroll"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
	// An enrolled host in the same build still resolves, without ambiguity.
	if got, err := resolveFirstInstallServerURL("https://hosted-b.example"); err != nil || got != "https://hosted-b.example" {
		t.Errorf("enrolled multi-region resolve = (%q, %v), want the configured host", got, err)
	}
}

// The production path must refuse to fetch a manifest over plaintext http even
// from an allowlisted host. Deliberately leaves clientOverride nil so the
// production branch of applyHostedFirstInstallSource is the one executed.
func TestApplyHostedFirstInstallSource_ProductionRequiresHTTPS(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	spec := firstInstallArtifactSpec{
		component: "watchdog", version: "1.2.3", goos: "linux", goarch: "amd64",
		serverURL: "http://hosted-a.example",
	}
	err := applyHostedFirstInstallSource(&spec)
	if err == nil {
		t.Fatal("plaintext http control-plane staging was allowed in production")
	}
	if !strings.Contains(err.Error(), "https") {
		t.Errorf("error %q does not name the https requirement", err)
	}
	if spec.serverSourced || spec.manifestBytes != nil {
		t.Fatal("spec was mutated despite the refusal")
	}
}

// persistedServerURLForInstall must degrade silently ONLY for the two shapes a
// not-yet-enrolled host really has. A broken config must say so: reporting it
// as "not enrolled yet" sends the operator to re-enroll instead of to the file.
func TestPersistedServerURLForInstall_DistinguishesFreshFromBroken(t *testing.T) {
	cases := []struct {
		name      string
		write     func(t *testing.T, path string)
		want      string
		wantWarn  bool
		warnNeeds string
	}{
		{"no config file at all", func(*testing.T, string) {}, "", false, ""},
		{"config without server_url", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("agent_id: abc\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}, "", false, ""},
		{"enrolled", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("server_url: https://hosted-a.example\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}, "https://hosted-a.example", false, ""},
		{"corrupt yaml warns", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("server_url: [unclosed\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}, "", true, "could not read the persisted server URL"},
		{"torn server_url warns", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("server_url: \"https://ba\x00d\"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}, "", true, "could not read the persisted server URL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "agent.yaml")
			tc.write(t, path)

			prevCfg := cfgFile
			cfgFile = path
			defer func() { cfgFile = prevCfg }()

			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			prevStderr := os.Stderr
			os.Stderr = w
			got := persistedServerURLForInstall()
			os.Stderr = prevStderr
			_ = w.Close()
			warned, _ := io.ReadAll(r)
			_ = r.Close()

			if got != tc.want {
				t.Errorf("persistedServerURLForInstall = %q, want %q", got, tc.want)
			}
			if tc.wantWarn {
				if !strings.Contains(string(warned), tc.warnNeeds) {
					t.Errorf("expected a stderr warning containing %q, got %q", tc.warnNeeds, warned)
				}
			} else if len(warned) != 0 {
				t.Errorf("expected no warning for a normal pre-enrollment shape, got %q", warned)
			}
		})
	}
}
