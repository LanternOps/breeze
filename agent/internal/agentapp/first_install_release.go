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
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

const (
	firstInstallManifestKeyID = "release-artifact-manifest-ed25519"
	firstInstallManifestKey   = "yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso="
	firstInstallRepository    = "LanternOps/breeze"
	maxFirstInstallManifest   = int64(1024 * 1024)
	maxFirstInstallArtifact   = int64(500 * 1024 * 1024)
)

var sourceCommitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var firstInstallVersionPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]*$`)

type firstInstallManifest struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Repository    string                      `json:"repository"`
	Release       string                      `json:"release"`
	SourceCommit  string                      `json:"sourceCommit"`
	Assets        []firstInstallManifestAsset `json:"assets"`
}

type firstInstallManifestAsset struct {
	Name          string `json:"name"`
	SHA256        string `json:"sha256"`
	Size          int64  `json:"size"`
	PlatformTrust string `json:"platformTrust"`
	IntendedUse   string `json:"intendedUse,omitempty"`
	Edition       string `json:"edition"`
}

type firstInstallArtifactSpec struct {
	component    string
	version      string
	goos         string
	goarch       string
	assetURL     string
	manifestURL  string
	signatureURL string
	destPath     string
	sourcePath   string
	client       *http.Client
	trustKeys    map[string]ed25519.PublicKey

	// serverURL is the persisted control-plane URL (config.Config.ServerURL),
	// empty on a host that has not run `enroll` yet. Hosted builds only.
	serverURL string

	// manifestBytes / signatureBytes carry the signed release manifest inline
	// instead of fetching it from manifestURL / signatureURL. Set by
	// applyHostedFirstInstallSource, which reads them from the control plane's
	// agent-versions response (#5899).
	manifestBytes  []byte
	signatureBytes []byte

	// serverSourced records that the manifest came from the enrolled control
	// plane rather than the public GitHub release. It relaxes exactly one
	// binding in verifyFirstInstallManifest — see the comment there.
	serverSourced bool
}

var releaseRepositoryPattern = regexp.MustCompile(`^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`)

func firstInstallReleaseRepository() (string, error) {
	repository := strings.TrimSpace(os.Getenv("BINARY_GITHUB_REPOSITORY"))
	if repository == "" {
		repository = firstInstallRepository
	}
	if !releaseRepositoryPattern.MatchString(repository) {
		return "", fmt.Errorf("release repository must be owner/repository")
	}
	parts := strings.Split(repository, "/")
	if strings.Trim(parts[0], ".") == "" || strings.Trim(parts[1], ".") == "" {
		return "", fmt.Errorf("release repository contains a dot-only segment")
	}
	return repository, nil
}

func firstInstallReleaseBase() string {
	repository := strings.TrimSpace(os.Getenv("BINARY_GITHUB_REPOSITORY"))
	if repository == "" {
		repository = firstInstallRepository
	}
	return "https://github.com/" + repository + "/releases/download"
}

func releaseManifestURL(version string) string {
	return fmt.Sprintf("%s/v%s/release-artifact-manifest.json", firstInstallReleaseBase(), version)
}

func releaseManifestSignatureURL(version string) string {
	return releaseManifestURL(version) + ".ed25519"
}

func firstInstallAssetName(component, goos, goarch string) (string, error) {
	if component != "watchdog" && component != "desktop-helper" {
		return "", fmt.Errorf("unsupported first-install component %q", component)
	}
	if goos != "windows" && goos != "linux" && goos != "darwin" {
		return "", fmt.Errorf("unsupported first-install OS %q", goos)
	}
	if goarch != "amd64" && goarch != "arm64" {
		return "", fmt.Errorf("unsupported first-install architecture %q", goarch)
	}
	if component == "desktop-helper" && goos != "darwin" {
		return "", fmt.Errorf("desktop helper first-install bootstrap is only supported on darwin")
	}
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("breeze-%s-%s-%s%s", component, goos, goarch, ext), nil
}

func expectedFirstInstallPlatformTrust(goos string) string {
	switch goos {
	case "darwin":
		return "macos-developer-id-notarization-required"
	case "windows":
		if hostpolicy.Enforced() {
			return "windows-authenticode-required"
		}
		return "none"
	default:
		return "release-workflow-produced"
	}
}

func firstInstallEditionAllowed(edition string) bool {
	if hostpolicy.Enforced() {
		return edition == "hosted"
	}
	return edition == "self-host"
}

func firstInstallTrustKeys() (map[string]ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(firstInstallManifestKey)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("embedded first-install manifest key is malformed")
	}
	keys := map[string]ed25519.PublicKey{firstInstallManifestKeyID: ed25519.PublicKey(raw)}
	for i, entry := range strings.Split(os.Getenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS"), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		id, encoded, ok := strings.Cut(entry, ":")
		if !ok || !config.ValidManifestKeyID(id) {
			return nil, fmt.Errorf("first-install manifest key entry #%d must use <keyId>:<base64>", i+1)
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("first-install manifest key entry #%d is not a base64 Ed25519 key", i+1)
		}
		if existing, exists := keys[id]; exists && !existing.Equal(ed25519.PublicKey(decoded)) {
			return nil, fmt.Errorf("first-install manifest key entry #%d conflicts with trusted key ID %s", i+1, id)
		}
		keys[id] = ed25519.PublicKey(decoded)
	}
	return keys, nil
}

func firstInstallHTTPClient() *http.Client {
	return &http.Client{
		Timeout: releaseDownloadTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many release redirects")
			}
			if req.URL.Scheme != "https" || !trustedReleaseHost(req.URL.Hostname()) {
				return fmt.Errorf("release redirect to untrusted origin")
			}
			return nil
		},
	}
}

func trustedReleaseHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "github.com" || host == "objects.githubusercontent.com" ||
		host == "release-assets.githubusercontent.com" {
		return true
	}
	// A hosted build also stages from its own control plane (#5899). The set it
	// adds is hostpolicy's compile-time allowlist — exact, case-insensitive,
	// no wildcard or suffix matching — and it is consulted ONLY in hosted mode:
	// in self-host mode AllowedHost permits every host, which must never widen
	// this set. hostpolicy.Enforced() is the guard that keeps self-host
	// behaviour byte-for-byte identical.
	return hostpolicy.Enforced() && hostpolicy.AllowedHost(host)
}

func validateFirstInstallURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || !trustedReleaseHost(parsed.Hostname()) || parsed.User != nil {
		return fmt.Errorf("release URL must use HTTPS on a trusted release host")
	}
	return nil
}

func fetchFirstInstallBytes(client *http.Client, rawURL, label string, max int64) ([]byte, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("%s URL is invalid", label)
	}
	resp, err := client.Get(rawURL)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", label, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: status %d", label, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", label, err)
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("%s exceeds %d-byte limit", label, max)
	}
	return data, nil
}

func verifyFirstInstallManifest(manifestBytes, signatureText []byte, spec firstInstallArtifactSpec) (firstInstallManifestAsset, error) {
	expectedRepository, err := firstInstallReleaseRepository()
	if err != nil {
		return firstInstallManifestAsset{}, err
	}
	keys := spec.trustKeys
	if keys == nil {
		var err error
		keys, err = firstInstallTrustKeys()
		if err != nil {
			return firstInstallManifestAsset{}, err
		}
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureText)))
	if err != nil || len(signature) != ed25519.SignatureSize {
		return firstInstallManifestAsset{}, fmt.Errorf("release manifest signature is not valid base64 Ed25519")
	}
	verified := false
	for _, key := range keys {
		if ed25519.Verify(key, manifestBytes, signature) {
			verified = true
			break
		}
	}
	if !verified {
		return firstInstallManifestAsset{}, fmt.Errorf("release manifest signature verification failed")
	}

	var manifest firstInstallManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return firstInstallManifestAsset{}, fmt.Errorf("release manifest is invalid JSON: %w", err)
	}
	// The `repository` field binds a GitHub-sourced manifest to the release the
	// agent asked for. A control-plane-sourced manifest cannot be bound that
	// way: a hosted build's artifacts are produced in a PRIVATE repository whose
	// name no shipped binary knows, and baking it in would put internal infra
	// naming into public source. What replaces it is not weaker — the manifest
	// is still signed by the embedded release key, and the release tag, asset
	// name, edition, platformTrust, size and SHA-256 all still bind below. This
	// mirrors the updater's own server-sourced manifest contract
	// (verifyReleaseArtifactManifest), which has never checked `repository`.
	repositoryMatches := spec.serverSourced || strings.EqualFold(manifest.Repository, expectedRepository)
	if manifest.SchemaVersion != 1 || !repositoryMatches ||
		manifest.Release != "v"+spec.version || !sourceCommitPattern.MatchString(manifest.SourceCommit) {
		return firstInstallManifestAsset{}, fmt.Errorf("release manifest identity tuple does not match requested release")
	}
	name, err := firstInstallAssetName(spec.component, spec.goos, spec.goarch)
	if err != nil {
		return firstInstallManifestAsset{}, err
	}
	var selected *firstInstallManifestAsset
	for i := range manifest.Assets {
		if manifest.Assets[i].Name != name {
			continue
		}
		if selected != nil {
			return firstInstallManifestAsset{}, fmt.Errorf("release manifest contains duplicate asset %s", name)
		}
		selected = &manifest.Assets[i]
	}
	if selected == nil {
		return firstInstallManifestAsset{}, fmt.Errorf("release manifest does not contain %s", name)
	}
	expectedTrust := expectedFirstInstallPlatformTrust(spec.goos)
	if spec.goos == "windows" && !strings.EqualFold(expectedRepository, firstInstallRepository) {
		expectedTrust = "windows-authenticode-required"
	}
	if selected.IntendedUse != "" || !firstInstallEditionAllowed(selected.Edition) || selected.PlatformTrust != expectedTrust {
		return firstInstallManifestAsset{}, fmt.Errorf("release manifest asset policy does not authorize %s", name)
	}
	if selected.Size < releaseAssetMinSize || selected.Size > maxFirstInstallArtifact ||
		len(selected.SHA256) != 64 {
		return firstInstallManifestAsset{}, fmt.Errorf("release manifest asset size or digest is invalid for %s", name)
	}
	if _, err := hex.DecodeString(selected.SHA256); err != nil {
		return firstInstallManifestAsset{}, fmt.Errorf("release manifest digest is invalid for %s", name)
	}
	return *selected, nil
}

func hashFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", 0, fmt.Errorf("artifact is not a regular file")
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, maxFirstInstallArtifact+1))
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func verifyFirstInstallFile(path string, asset firstInstallManifestAsset) error {
	digest, size, err := hashFile(path)
	if err != nil {
		return fmt.Errorf("hash staged artifact: %w", err)
	}
	if size != asset.Size || digest != asset.SHA256 {
		return fmt.Errorf("staged artifact does not match signed release manifest")
	}
	return nil
}

func stageFirstInstallArtifact(spec firstInstallArtifactSpec) error {
	if !firstInstallVersionPattern.MatchString(spec.version) {
		return fmt.Errorf("release version is malformed")
	}
	if _, err := firstInstallReleaseRepository(); err != nil {
		return err
	}
	// Hosted builds re-point the manifest (and, absent a local sibling, the
	// artifact) at their own control plane: the public GitHub release only ever
	// carries self-host-edition assets, which a hosted build refuses by policy
	// (#5899). No-op for self-host builds and for the manifest-URL test seam.
	if err := applyHostedFirstInstallSource(&spec); err != nil {
		return err
	}
	client := spec.client
	productionClient := client == nil
	if client == nil {
		client = firstInstallHTTPClient()
	}
	inlineManifest := len(spec.manifestBytes) > 0
	manifestURL := spec.manifestURL
	if manifestURL == "" {
		manifestURL = releaseManifestURL(spec.version)
	}
	signatureURL := spec.signatureURL
	if signatureURL == "" {
		signatureURL = releaseManifestSignatureURL(spec.version)
	}
	if productionClient {
		if !inlineManifest {
			for _, rawURL := range []string{manifestURL, signatureURL} {
				if err := validateFirstInstallURL(rawURL); err != nil {
					return err
				}
			}
		}
		if spec.sourcePath == "" {
			if err := validateFirstInstallURL(spec.assetURL); err != nil {
				return err
			}
		}
	}
	manifest, signature := spec.manifestBytes, spec.signatureBytes
	if !inlineManifest {
		var err error
		manifest, err = fetchFirstInstallBytes(client, manifestURL, "release manifest", maxFirstInstallManifest)
		if err != nil {
			return err
		}
		signature, err = fetchFirstInstallBytes(client, signatureURL, "release manifest signature", 4096)
		if err != nil {
			return err
		}
	}
	asset, err := verifyFirstInstallManifest(manifest, signature, spec)
	if err != nil {
		return err
	}
	if spec.sourcePath != "" {
		if err := verifyFirstInstallFile(spec.sourcePath, asset); err != nil {
			return err
		}
		return copyVerifiedFirstInstallFile(spec.sourcePath, spec.destPath, asset)
	}
	if spec.assetURL == "" {
		return fmt.Errorf("release artifact URL is required")
	}
	return downloadVerifiedFirstInstallFile(client, spec.assetURL, spec.destPath, asset)
}

func secureTempFor(destPath string) (*os.File, error) {
	dir := filepath.Dir(destPath)
	f, err := os.CreateTemp(dir, "."+filepath.Base(destPath)+".download-*")
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o755); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return nil, err
	}
	return f, nil
}

func writeVerifiedFirstInstallFile(destPath string, asset firstInstallManifestAsset, copyBody func(io.Writer) error) error {
	tmp, err := secureTempFor(destPath)
	if err != nil {
		return fmt.Errorf("create protected staging file: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) }
	defer cleanup()
	if err := copyBody(tmp); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := verifyFirstInstallFile(tmpPath, asset); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, destPath); err != nil {
		return fmt.Errorf("install verified artifact: %w", err)
	}
	return verifyFirstInstallFile(destPath, asset)
}

func copyVerifiedFirstInstallFile(sourcePath, destPath string, asset firstInstallManifestAsset) error {
	return writeVerifiedFirstInstallFile(destPath, asset, func(dst io.Writer) error {
		src, err := os.Open(sourcePath)
		if err != nil {
			return err
		}
		defer func() { _ = src.Close() }()
		_, err = io.Copy(dst, io.LimitReader(src, maxFirstInstallArtifact+1))
		return err
	})
}

// copyProtectedPackagedSibling is used only after protectedPackagedSibling has
// established that the source came from the OS package's privileged install
// directory. Package/download signature verification is the content boundary;
// this copy preserves the filesystem boundary and never executes from the
// original path.
func copyProtectedPackagedSibling(sourcePath, destPath string) error {
	src, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	tmp, err := secureTempFor(destPath)
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	n, copyErr := io.Copy(tmp, io.LimitReader(src, maxFirstInstallArtifact+1))
	if copyErr != nil || n < releaseAssetMinSize || n > maxFirstInstallArtifact {
		_ = tmp.Close()
		if copyErr != nil {
			return copyErr
		}
		return fmt.Errorf("protected packaged sibling size is outside the allowed range")
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, destPath)
}

func downloadVerifiedFirstInstallFile(client *http.Client, rawURL, destPath string, asset firstInstallManifestAsset) error {
	resp, err := client.Get(rawURL)
	if err != nil {
		return fmt.Errorf("fetch release artifact: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch release artifact: status %d", resp.StatusCode)
	}
	if resp.ContentLength >= 0 && resp.ContentLength != asset.Size {
		return fmt.Errorf("release artifact content length does not match signed size")
	}
	return writeVerifiedFirstInstallFile(destPath, asset, func(dst io.Writer) error {
		n, err := io.Copy(dst, io.LimitReader(resp.Body, asset.Size+1))
		if err != nil {
			return err
		}
		if n != asset.Size {
			return fmt.Errorf("release artifact body does not match signed size")
		}
		return nil
	})
}
