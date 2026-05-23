package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/secmem"
)

var log = logging.L("updater")

// Config holds updater configuration
type Config struct {
	ServerURL      string
	AuthToken      *secmem.SecureString
	CurrentVersion string
	Component      string
	BinaryPath     string
	BackupPath     string

	// PinnedManifestPubKeys are deployment-specific Ed25519 pubkeys delivered
	// by the API via enrollment/heartbeat and pinned TOFU-style. Format
	// matches agent config: "<keyId>:<base64-raw-pubkey>". Merged with the
	// embedded LanternOps trust root in trustedManifestKeys() so self-host
	// (BINARY_SOURCE=local) deployments can verify locally-signed manifests.
	PinnedManifestPubKeys []string
}

// Updater handles agent auto-updates
type Updater struct {
	config *Config
	client *http.Client
	// extras is set by UpdateToWithCompanions / UpdateFromURLWithCompanions
	// to forward companion-binary paths (e.g. breeze-user-helper.exe) into
	// the Windows restart helper. Not user-visible. Issue #816.
	extras updateExtras
}

// New creates a new Updater
func New(cfg *Config) *Updater {
	return &Updater{
		config: cfg,
		client: &http.Client{Timeout: 5 * time.Minute},
	}
}

// updateExtras carries optional companion-binary info into the Windows
// restart helper. It is set transiently via the Updater's exported
// UpdateToWithCompanions / UpdateFromURLWithCompanions wrappers so the
// existing UpdateTo signature stays stable. Issue #816.
type updateExtras struct {
	userHelperTempPath   string
	userHelperTargetPath string
}

// ErrReadOnlyFS is returned when the binary path is on a read-only filesystem.
// Callers should treat this as a permanent failure and stop retrying.
var ErrReadOnlyFS = fmt.Errorf("binary path is on a read-only filesystem")

// ErrTextBusy is returned when the binary is currently executing (ETXTBSY).
// This is transient — the unlink-before-write in replaceBinary handles it,
// but this sentinel prevents misclassification as ErrReadOnlyFS.
var ErrTextBusy = fmt.Errorf("binary is currently executing")

const maxUpdateBinaryBytes int64 = 500 * 1024 * 1024

// trustedUpdateManifestPublicKeys is the embedded trust root for release
// manifest signatures. It MUST match the raw Ed25519 public key in
// internal/release-keys/release-manifest.ed25519.pub (the SPKI suffix); the
// release.yml workflow signs every manifest with the corresponding private
// key. TestEmbeddedTrustRootMatchesRepoPubKey enforces that match at build
// time so the agent never ships with a mismatched trust root again.
//
// Self-hosters can append additional base64 raw Ed25519 public keys via the
// BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS env var (read in trustedManifestKeys).
var trustedUpdateManifestPublicKeys = []string{
	"yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=",
}

type updateManifest struct {
	Version   string `json:"version"`
	Component string `json:"component"`
	Platform  string `json:"platform"`
	Arch      string `json:"arch"`
	URL       string `json:"url"`
	Checksum  string `json:"checksum"`
	Size      int64  `json:"size,omitempty"`
}

type releaseArtifactManifest struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Release       string                 `json:"release"`
	Assets        []releaseArtifactAsset `json:"assets"`
}

type releaseArtifactAsset struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func (u *Updater) component() string {
	if u.config != nil && strings.TrimSpace(u.config.Component) != "" {
		return strings.TrimSpace(u.config.Component)
	}
	return "agent"
}

func manifestPlatform() string {
	if runtime.GOOS == "darwin" {
		return "macos"
	}
	return runtime.GOOS
}

func releaseTagMatchesVersion(tag, version string) bool {
	return tag == version || tag == "v"+version
}

func assetNameFromURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	parts := strings.Split(strings.TrimRight(parsed.Path, "/"), "/")
	if len(parts) == 0 || parts[len(parts)-1] == "" {
		return "", fmt.Errorf("download URL does not include an asset filename")
	}
	name, err := url.PathUnescape(parts[len(parts)-1])
	if err != nil {
		return "", err
	}
	return name, nil
}

func (u *Updater) expectedReleaseAssetNames() map[string]struct{} {
	switch u.component() {
	case "agent":
		suffix := ""
		if runtime.GOOS == "windows" {
			suffix = ".exe"
		}
		return map[string]struct{}{
			fmt.Sprintf("breeze-agent-%s-%s%s", runtime.GOOS, runtime.GOARCH, suffix): {},
		}
	case "helper":
		switch runtime.GOOS {
		case "windows":
			return map[string]struct{}{"breeze-helper-windows.msi": {}}
		case "darwin":
			return map[string]struct{}{"breeze-helper-macos.dmg": {}}
		case "linux":
			return map[string]struct{}{"breeze-helper-linux.AppImage": {}}
		}
	case "viewer":
		switch manifestPlatform() {
		case "windows":
			return map[string]struct{}{"breeze-viewer-windows.msi": {}}
		case "macos":
			return map[string]struct{}{"breeze-viewer-macos.dmg": {}}
		case "linux":
			return map[string]struct{}{"breeze-viewer-linux.AppImage": {}}
		}
	case "user-helper":
		// breeze-user-helper is the GUI-subsystem sibling of breeze-agent
		// that runs in interactive user sessions (sessionbroker spawn path).
		// It only exists on Windows — Linux/macOS user-session work is
		// handled by other surfaces. See agent/installer/build-msi.ps1
		// for how it's bundled into the installer; the in-place
		// auto-upgrade path (#816) downloads it as a separate artifact.
		if runtime.GOOS == "windows" {
			return map[string]struct{}{
				fmt.Sprintf("breeze-user-helper-%s-%s.exe", runtime.GOOS, runtime.GOARCH): {},
			}
		}
	}
	return map[string]struct{}{}
}

func (u *Updater) trustedManifestKeys() []ed25519.PublicKey {
	configured := strings.TrimSpace(os.Getenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS"))
	rawKeys := append([]string{}, trustedUpdateManifestPublicKeys...)
	if configured != "" {
		rawKeys = append(rawKeys, strings.Split(configured, ",")...)
	}
	// Per-deployment pinned keys delivered by the API via enrollment/heartbeat
	// (see #625). Format on disk: "<keyId>:<base64-pubkey>".
	if u != nil && u.config != nil {
		for _, entry := range u.config.PinnedManifestPubKeys {
			parts := strings.SplitN(entry, ":", 2)
			if len(parts) == 2 && parts[1] != "" {
				rawKeys = append(rawKeys, parts[1])
			}
		}
	}

	keys := make([]ed25519.PublicKey, 0, len(rawKeys))
	for _, raw := range rawKeys {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			continue
		}
		keys = append(keys, ed25519.PublicKey(decoded))
	}
	return keys
}

func normalizePreflightErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrFileLocked) {
		return err
	}
	if errors.Is(err, ErrTextBusy) {
		return err
	}
	// Only classify known read-only indicators as permanent.
	// Transient errors (ENOMEM, EMFILE, EIO, etc.) should not
	// permanently disable auto-update.
	if errors.Is(err, syscall.EROFS) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
		return fmt.Errorf("%w: %v", ErrReadOnlyFS, err)
	}
	return err
}

// writeUpdateMarker creates a transient file that tells the new process
// to skip startup jitter and send an immediate heartbeat.
func writeUpdateMarker(version string) {
	markerPath := filepath.Join(config.ConfigDir(), ".update-restart")
	if err := os.WriteFile(markerPath, []byte(version), 0600); err != nil {
		log.Warn("failed to write update marker", "path", markerPath, "error", err.Error())
	}
}

// UpdateToWithUserHelper behaves like UpdateTo but also instructs the Windows
// restart helper to copy a freshly-downloaded breeze-user-helper.exe into
// place alongside the agent. Empty paths fall back to agent-only behavior.
// Issue #816.
//
// Cleanup contract: on UpdateTo failure, the user-helper temp file is
// removed here too. UpdateTo's own error branches only know about the agent
// tempPath, so without this cleanup the pre-downloaded helper would orphan
// in %TEMP% on every failed upgrade. On success (UpdateTo returns nil) we
// intentionally leave the file in place — the spawned restart script owns
// it and removes it after the swap.
func (u *Updater) UpdateToWithUserHelper(version, userHelperTempPath, userHelperTargetPath string) error {
	u.extras.userHelperTempPath = userHelperTempPath
	u.extras.userHelperTargetPath = userHelperTargetPath
	err := u.UpdateTo(version)
	if err != nil && userHelperTempPath != "" {
		removeCleanup(userHelperTempPath)
	}
	return err
}

// UpdateTo downloads and installs a new version
func (u *Updater) UpdateTo(version string) error {
	log.Info("starting update", "targetVersion", version)

	// Pre-flight: verify we can write to the binary's directory.
	// ProtectSystem=strict in systemd or immutable filesystems (e.g. Ubuntu Core)
	// make /usr/local/bin read-only, so detect this early instead of failing
	// after download + checksum + backup.
	if runtime.GOOS != "windows" {
		if err := checkWritable(u.config.BinaryPath); err != nil {
			return normalizePreflightErr(err)
		}
	}

	// 1. Download binary to temp file
	tempPath, manifest, err := u.downloadBinary(version)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}

	// 2. Verify checksum
	if err := u.verifyChecksum(tempPath, manifest.Checksum); err != nil {
		removeCleanup(tempPath)
		return fmt.Errorf("checksum verification failed: %w", err)
	}

	// 3. Backup current binary
	if err := u.backupCurrentBinary(); err != nil {
		removeCleanup(tempPath)
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	// 4. On Windows, spawn a helper script that swaps the binary externally.
	//    The script handles: stop service -> copy new binary -> start service.
	//    The agent exits normally after spawning the script.
	if runtime.GOOS == "windows" {
		writeUpdateMarker(version)
		// User-helper swap is wired in by the heartbeat-layer caller
		// (heartbeat.doUpgrade), not here — the updater package is
		// component-agnostic, and downloading a second component requires
		// the caller's AuthToken/server context. Pass empty strings for an
		// agent-only swap (backward compatible). Issue #816.
		if err := RestartWithHelper(tempPath, u.config.BinaryPath, u.extras.userHelperTempPath, u.extras.userHelperTargetPath); err != nil {
			removeCleanup(tempPath)
			// The user-helper temp was pre-downloaded by the caller before
			// UpdateTo was invoked; if we never spawned the restart script,
			// nothing will ever clean it up. Mirror the agent tempPath
			// cleanup so failed spawns don't leak helper temps in %TEMP%.
			if u.extras.userHelperTempPath != "" {
				removeCleanup(u.extras.userHelperTempPath)
			}
			if rbErr := u.Rollback(); rbErr != nil {
				log.Error("rollback also failed", "originalError", err, "rollbackError", rbErr)
			}
			return fmt.Errorf("failed to spawn update helper: %w", err)
		}
		// Helper script will handle the rest -- agent exits via service stop.
		return nil
	}

	// 5. macOS: download and install via .pkg if available.
	//    The .pkg preserves the Apple Developer ID code signature and runs
	//    pre/post-install scripts. The raw binary approach destroys the
	//    signature, which invalidates macOS TCC permission grants.
	if runtime.GOOS == "darwin" {
		defer removeCleanup(tempPath)
		writeUpdateMarker(version)
		pkgErr := u.installViaPkg(version)
		if pkgErr == nil {
			return nil // .pkg install handles binary replacement + restart
		}
		log.Warn("pkg install failed, falling back to binary replacement", "error", pkgErr.Error())
	} else {
		defer removeCleanup(tempPath)
	}

	// 6. Non-macOS or pkg fallback: replace binary inline and restart
	if err := u.replaceBinary(tempPath); err != nil {
		// Catch TOCTOU race: pre-flight passed but FS became read-only before write
		if isReadOnlyErr(err) {
			return fmt.Errorf("%w: %v", ErrReadOnlyFS, err)
		}
		if rbErr := u.Rollback(); rbErr != nil {
			log.Error("rollback also failed after replace error", "replaceError", err, "rollbackError", rbErr)
			return fmt.Errorf("failed to replace binary: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("failed to replace binary (rolled back): %w", err)
	}

	writeUpdateMarker(version)
	if err := Restart(); err != nil {
		if rbErr := u.Rollback(); rbErr != nil {
			log.Error("rollback also failed after restart error", "restartError", err, "rollbackError", rbErr)
			return fmt.Errorf("failed to restart: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("failed to restart (rolled back): %w", err)
	}

	return nil
}

// downloadInfo holds the JSON response from the download endpoint
type downloadInfo struct {
	URL               string `json:"url"`
	Checksum          string `json:"checksum"`
	Manifest          string `json:"manifest"`
	ManifestSignature string `json:"manifestSignature"`
}

func (u *Updater) requestWithoutRedirect(req *http.Request) (*http.Response, error) {
	client := *u.client
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return client.Do(req)
}

func (u *Updater) parseDownloadInfo(resp *http.Response) (downloadInfo, error) {
	switch resp.StatusCode {
	case http.StatusOK:
		var info downloadInfo
		if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
			return downloadInfo{}, fmt.Errorf("failed to parse download info: %w", err)
		}
		if info.URL == "" || info.Checksum == "" {
			return downloadInfo{}, fmt.Errorf("download info missing url or checksum")
		}
		if info.Manifest == "" || info.ManifestSignature == "" {
			return downloadInfo{}, fmt.Errorf("download info missing signed release manifest")
		}
		return info, nil

	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		location, err := resp.Location()
		if err != nil {
			return downloadInfo{}, fmt.Errorf("download redirect missing location: %w", err)
		}
		return downloadInfo{}, fmt.Errorf("download redirects are not trusted without a signed release manifest (location %s)", location.String())

	default:
		return downloadInfo{}, fmt.Errorf("download info request failed with status %d", resp.StatusCode)
	}
}

func (u *Updater) verifyUpdateManifest(info downloadInfo, version string) (updateManifest, error) {
	signature, err := base64.StdEncoding.DecodeString(info.ManifestSignature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return updateManifest{}, fmt.Errorf("invalid update manifest signature encoding")
	}

	keys := u.trustedManifestKeys()
	if len(keys) == 0 {
		return updateManifest{}, fmt.Errorf("no trusted update manifest public keys configured")
	}

	payload := []byte(info.Manifest)
	verified := false
	for _, key := range keys {
		if ed25519.Verify(key, payload, signature) {
			verified = true
			break
		}
	}
	if !verified {
		return updateManifest{}, fmt.Errorf("update manifest signature verification failed")
	}

	var manifest updateManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return updateManifest{}, fmt.Errorf("invalid update manifest JSON: %w", err)
	}
	if manifest.Version == "" && manifest.Checksum == "" {
		return u.verifyReleaseArtifactManifest(payload, info, version)
	}

	if manifest.Version != version {
		return updateManifest{}, fmt.Errorf("update manifest version mismatch: expected %s, got %s", version, manifest.Version)
	}
	if manifest.Component != u.component() {
		return updateManifest{}, fmt.Errorf("update manifest component mismatch: expected %s, got %s", u.component(), manifest.Component)
	}
	if manifest.Platform != manifestPlatform() {
		return updateManifest{}, fmt.Errorf("update manifest platform mismatch: expected %s, got %s", manifestPlatform(), manifest.Platform)
	}
	if manifest.Arch != runtime.GOARCH {
		return updateManifest{}, fmt.Errorf("update manifest architecture mismatch: expected %s, got %s", runtime.GOARCH, manifest.Arch)
	}
	// The checksum equality below is the trust binding — it ties the
	// signed manifest to the bytes the server is offering. We deliberately
	// do NOT require manifest.URL == info.URL: the signed URL is canonical
	// (e.g. github.com release artifact) while info.URL may be a server-
	// relative proxy URL the API uses to keep the download flow inside the
	// agent's trusted origin (see downloadFromURL host check). Issue #646.
	if manifest.Checksum != info.Checksum {
		return updateManifest{}, fmt.Errorf("update manifest does not match download metadata")
	}
	if len(manifest.Checksum) != 64 {
		return updateManifest{}, fmt.Errorf("update manifest checksum must be SHA-256 hex")
	}
	if _, err := hex.DecodeString(manifest.Checksum); err != nil {
		return updateManifest{}, fmt.Errorf("update manifest checksum is not valid hex: %w", err)
	}
	if manifest.Size < 0 || manifest.Size > maxUpdateBinaryBytes {
		return updateManifest{}, fmt.Errorf("update manifest size %d exceeds allowed bounds", manifest.Size)
	}

	return manifest, nil
}

func (u *Updater) verifyReleaseArtifactManifest(payload []byte, info downloadInfo, version string) (updateManifest, error) {
	var manifest releaseArtifactManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return updateManifest{}, fmt.Errorf("invalid release artifact manifest JSON: %w", err)
	}
	if manifest.SchemaVersion != 1 {
		return updateManifest{}, fmt.Errorf("unsupported release artifact manifest schema version %d", manifest.SchemaVersion)
	}
	if !releaseTagMatchesVersion(manifest.Release, version) {
		return updateManifest{}, fmt.Errorf("release artifact manifest version mismatch: expected %s, got %s", version, manifest.Release)
	}

	// Asset name is derived from the agent's own platform/arch/component
	// rather than parsed from info.URL — the URL may be a server-relative
	// proxy (e.g. https://breeze.example.com/api/v1/agents/download/...)
	// whose last segment is not the asset filename. The signed manifest's
	// asset list still uses canonical names like "breeze-agent-windows-amd64.exe".
	// Issue #646.
	expected := u.expectedReleaseAssetNames()
	if len(expected) == 0 {
		return updateManifest{}, fmt.Errorf("no expected release asset names configured for component %q", u.component())
	}
	if len(expected) != 1 {
		// Defensive: expectedReleaseAssetNames always returns exactly one
		// entry per (platform, arch, component) tuple. Surface this clearly
		// if a future change adds ambiguity rather than silently picking one.
		return updateManifest{}, fmt.Errorf("ambiguous expected asset names for component %q: %v", u.component(), expected)
	}
	var assetName string
	for name := range expected {
		assetName = name
	}

	var selected *releaseArtifactAsset
	for i := range manifest.Assets {
		if manifest.Assets[i].Name == assetName {
			selected = &manifest.Assets[i]
			break
		}
	}
	if selected == nil {
		return updateManifest{}, fmt.Errorf("release artifact manifest does not include %s", assetName)
	}
	if len(selected.SHA256) != 64 {
		return updateManifest{}, fmt.Errorf("release artifact manifest checksum must be SHA-256 hex")
	}
	if _, err := hex.DecodeString(selected.SHA256); err != nil {
		return updateManifest{}, fmt.Errorf("release artifact manifest checksum is not valid hex: %w", err)
	}
	if selected.SHA256 != info.Checksum {
		return updateManifest{}, fmt.Errorf("release artifact manifest does not match download metadata")
	}
	if selected.Size < 0 || selected.Size > maxUpdateBinaryBytes {
		return updateManifest{}, fmt.Errorf("release artifact manifest size %d exceeds allowed bounds", selected.Size)
	}

	return updateManifest{
		Version:   version,
		Component: u.component(),
		Platform:  manifestPlatform(),
		Arch:      runtime.GOARCH,
		URL:       info.URL,
		Checksum:  selected.SHA256,
		Size:      selected.Size,
	}, nil
}

// DownloadBinary is the exported wrapper around downloadBinary used by
// callers that need to pre-download a companion artifact (e.g. the
// breeze-user-helper.exe) outside the full UpdateTo flow. Returns the
// temp-file path on success after verifying the downloaded bytes against
// the signed manifest checksum. The caller is responsible for cleanup.
// Issue #816.
func (u *Updater) DownloadBinary(version string) (string, error) {
	tempPath, manifest, err := u.downloadBinary(version)
	if err != nil {
		return "", err
	}
	if err := u.verifyChecksum(tempPath, manifest.Checksum); err != nil {
		removeCleanup(tempPath)
		return "", fmt.Errorf("checksum verification failed: %w", err)
	}
	return tempPath, nil
}

// downloadBinary fetches download info from the API and then downloads the binary.
// Supports both legacy redirect responses and JSON info responses.
func (u *Updater) downloadBinary(version string) (string, updateManifest, error) {
	if u.config.AuthToken == nil {
		return "", updateManifest{}, fmt.Errorf("auth token not available")
	}
	// Step 1: Get download URL + checksum from API.
	infoURL := fmt.Sprintf("%s/api/v1/agent-versions/%s/download?platform=%s&arch=%s&component=%s",
		u.config.ServerURL, version, runtime.GOOS, runtime.GOARCH, url.QueryEscape(u.component()))

	req, err := http.NewRequest("GET", infoURL, nil)
	if err != nil {
		return "", updateManifest{}, err
	}
	req.Header.Set("Authorization", "Bearer "+u.config.AuthToken.Reveal())

	resp, err := u.requestWithoutRedirect(req)
	if err != nil {
		return "", updateManifest{}, err
	}
	defer resp.Body.Close()

	info, err := u.parseDownloadInfo(resp)
	if err != nil {
		return "", updateManifest{}, err
	}

	manifest, err := u.verifyUpdateManifest(info, version)
	if err != nil {
		return "", updateManifest{}, err
	}

	// Step 2: Download the actual binary from the manifest URL. downloadFromURL
	// enforces scheme and origin against the configured control-plane URL.
	tempPath, err := u.downloadFromURL(info.URL)
	if err != nil {
		return "", updateManifest{}, err
	}
	if manifest.Size > 0 {
		stat, err := os.Stat(tempPath)
		if err != nil {
			removeCleanup(tempPath)
			return "", updateManifest{}, err
		}
		if stat.Size() != manifest.Size {
			removeCleanup(tempPath)
			return "", updateManifest{}, fmt.Errorf("downloaded binary size mismatch: expected %d, got %d", manifest.Size, stat.Size())
		}
	}

	return tempPath, manifest, nil
}

// verifyChecksum verifies the SHA256 checksum of a file
func (u *Updater) verifyChecksum(path, expectedChecksum string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return err
	}

	actualChecksum := hex.EncodeToString(hasher.Sum(nil))
	if actualChecksum != expectedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, actualChecksum)
	}

	return nil
}

// backupCurrentBinary creates a backup of the current binary
func (u *Updater) backupCurrentBinary() error {
	// Remove old backup if exists
	removeCleanup(u.config.BackupPath)

	// Copy current binary to backup
	src, err := os.Open(u.config.BinaryPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(u.config.BackupPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return err
	}

	// Copy permissions
	info, err := os.Stat(u.config.BinaryPath)
	if err != nil {
		return err
	}
	return os.Chmod(u.config.BackupPath, info.Mode())
}

// replaceBinary replaces the current binary with a new one
func (u *Updater) replaceBinary(newPath string) error {
	// On Unix, we can rename over the existing file
	// On Windows, we need to rename the existing file first
	if runtime.GOOS == "windows" {
		oldPath := u.config.BinaryPath + ".old"
		removeCleanup(oldPath)
		if err := os.Rename(u.config.BinaryPath, oldPath); err != nil {
			return err
		}
	}

	// On Unix, unlink the old binary before creating the new file.
	// The kernel keeps the old inode alive for the running process's
	// memory-mapped text segment. The new file gets a fresh inode,
	// avoiding ETXTBSY ("text file busy") errors.
	if runtime.GOOS != "windows" {
		os.Remove(u.config.BinaryPath)
	}

	// Copy new binary to target location
	src, err := os.Open(newPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(u.config.BinaryPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return err
	}

	// Set executable permissions on Unix
	if runtime.GOOS != "windows" {
		if err := os.Chmod(u.config.BinaryPath, 0755); err != nil {
			return err
		}
	}

	// macOS: only ad-hoc sign if the binary isn't already properly signed.
	// Release binaries are Apple Developer ID signed — re-signing with adhoc
	// destroys the signature, which invalidates TCC permission grants.
	if runtime.GOOS == "darwin" {
		verifyCmd := exec.Command("codesign", "--verify", "--verbose", u.config.BinaryPath)
		if err := verifyCmd.Run(); err != nil {
			// Not signed or signature invalid — apply adhoc signature so macOS allows execution
			cmd := exec.Command("codesign", "--force", "--sign", "-", u.config.BinaryPath)
			if err := cmd.Run(); err != nil {
				log.Warn("ad-hoc codesign failed, binary may not launch", "error", err.Error())
			}
		}
	}

	return nil
}

// DownloadAndVerify downloads a binary from the URL and verifies its
// SHA-256 checksum, returning the path to the verified temp file. The
// caller is responsible for moving the file into place and removing the
// temp file. Used by dev_push when updating a non-agent binary (e.g. the
// desktop helper) so the updater's automatic replace+restart flow is skipped.
func (u *Updater) DownloadAndVerify(url, expectedChecksum string) (string, error) {
	tempPath, err := u.downloadFromURL(url)
	if err != nil {
		return "", fmt.Errorf("failed to download binary: %w", err)
	}
	if err := u.verifyChecksum(tempPath, expectedChecksum); err != nil {
		removeCleanup(tempPath)
		return "", fmt.Errorf("checksum verification failed: %w", err)
	}
	return tempPath, nil
}

// UpdateFromURL downloads a binary directly from a URL (skipping the version-lookup
// API call used by UpdateTo). Used by dev_push for fast iteration.
func (u *Updater) UpdateFromURL(url, expectedChecksum string) error {
	log.Info("starting dev update from URL", "url", url)

	// Pre-flight: verify we can write to the binary's directory.
	// Skip on Windows — the running exe is locked by the OS, but
	// RestartWithHelper handles this by waiting for process exit
	// before copying the new binary.
	if runtime.GOOS != "windows" {
		if err := checkWritable(u.config.BinaryPath); err != nil {
			return normalizePreflightErr(err)
		}
	}

	// 1. Download binary directly
	tempPath, err := u.downloadFromURL(url)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}

	// 2. Verify checksum
	if err := u.verifyChecksum(tempPath, expectedChecksum); err != nil {
		removeCleanup(tempPath)
		return fmt.Errorf("checksum verification failed: %w", err)
	}

	// 3. Backup current binary
	if err := u.backupCurrentBinary(); err != nil {
		removeCleanup(tempPath)
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	// 4. Windows: spawn helper script for binary swap
	if runtime.GOOS == "windows" {
		if err := RestartWithHelper(tempPath, u.config.BinaryPath, u.extras.userHelperTempPath, u.extras.userHelperTargetPath); err != nil {
			removeCleanup(tempPath)
			if rbErr := u.Rollback(); rbErr != nil {
				log.Error("rollback also failed", "originalError", err, "rollbackError", rbErr)
			}
			return fmt.Errorf("failed to spawn update helper: %w", err)
		}
		return nil
	}

	// 5. Non-Windows: replace binary inline and restart
	defer removeCleanup(tempPath)
	if err := u.replaceBinary(tempPath); err != nil {
		if isReadOnlyErr(err) {
			return fmt.Errorf("%w: %v", ErrReadOnlyFS, err)
		}
		if rbErr := u.Rollback(); rbErr != nil {
			log.Error("rollback also failed after replace error", "replaceError", err, "rollbackError", rbErr)
			return fmt.Errorf("failed to replace binary: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("failed to replace binary (rolled back): %w", err)
	}

	if err := Restart(); err != nil {
		if rbErr := u.Rollback(); rbErr != nil {
			log.Error("rollback also failed after restart error", "restartError", err, "rollbackError", rbErr)
			return fmt.Errorf("failed to restart: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("failed to restart (rolled back): %w", err)
	}

	return nil
}

// downloadFromURL downloads a binary directly from the given URL to a temp file.
// The URL origin (host and scheme) must match the configured ServerURL to prevent credential leakage.
func (u *Updater) downloadFromURL(rawURL string) (string, error) {
	if u.config.AuthToken == nil {
		return "", fmt.Errorf("auth token not available")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("invalid download URL: %w", err)
	}
	serverParsed, err := url.Parse(u.config.ServerURL)
	if err != nil {
		return "", fmt.Errorf("invalid server URL: %w", err)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", fmt.Errorf("unsupported download URL scheme: %q", parsed.Scheme)
	}
	if serverParsed.Scheme != "https" && serverParsed.Scheme != "http" {
		return "", fmt.Errorf("unsupported server URL scheme: %q", serverParsed.Scheme)
	}
	if parsed.Host != serverParsed.Host {
		return "", fmt.Errorf("download URL host %q does not match server %q", parsed.Host, serverParsed.Host)
	}
	// Never downgrade from an HTTPS control plane to HTTP binary downloads.
	if serverParsed.Scheme == "https" && parsed.Scheme != "https" {
		return "", fmt.Errorf("insecure download URL scheme %q for HTTPS server", parsed.Scheme)
	}
	// Keep protocol aligned to avoid credential scope surprises.
	if parsed.Scheme != serverParsed.Scheme && !(serverParsed.Scheme == "http" && parsed.Scheme == "https") {
		return "", fmt.Errorf("download URL scheme %q does not match server scheme %q", parsed.Scheme, serverParsed.Scheme)
	}

	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+u.config.AuthToken.Reveal())

	resp, err := u.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to download binary: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("binary download failed with status %d", resp.StatusCode)
	}

	tempFile, err := os.CreateTemp("", "breeze-agent-dev-*")
	if err != nil {
		return "", err
	}
	defer tempFile.Close()

	if _, err := io.Copy(tempFile, resp.Body); err != nil {
		removeCleanup(tempFile.Name())
		return "", err
	}

	return tempFile.Name(), nil
}

// ErrFileLocked is returned when the binary is locked by another process.
// This is transient (not permanent like ErrReadOnlyFS) and should be retried.
var ErrFileLocked = fmt.Errorf("binary is locked by another process")

// checkWritable verifies we can write to the target binary path by opening
// the existing file for writing without truncating it. This tests file-level
// write permission, matching what replaceBinary (os.Create) does, and works
// correctly with systemd's ReadWritePaths which grants per-file access.
func checkWritable(binaryPath string) error {
	f, err := os.OpenFile(binaryPath, os.O_WRONLY, 0)
	if err != nil {
		if isFileLocked(err) {
			return fmt.Errorf("%w: %v", ErrFileLocked, err)
		}
		// ETXTBSY means the binary is running but the filesystem is writable.
		// replaceBinary handles this via unlink-before-write (fresh inode),
		// so this is not a writability problem — let the update proceed.
		if errors.Is(err, syscall.ETXTBSY) {
			return nil
		}
		return err
	}
	return f.Close()
}

// isReadOnlyErr returns true if the error indicates a read-only filesystem
// or permission denied — used to catch TOCTOU races where the pre-flight
// check passed but the filesystem became read-only before replaceBinary.
func isReadOnlyErr(err error) bool {
	return errors.Is(err, syscall.EROFS) || errors.Is(err, syscall.EACCES)
}

// removeCleanup removes a file and logs a warning on failure.
func removeCleanup(path string) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to clean up temp file", "path", path, "error", err.Error())
	}
}

// Rollback restores the backup binary
func (u *Updater) Rollback() error {
	log.Info("rolling back to previous version")

	if _, err := os.Stat(u.config.BackupPath); os.IsNotExist(err) {
		return fmt.Errorf("no backup found at %s", u.config.BackupPath)
	}

	// On Unix, unlink the current binary before writing the backup.
	// Same reason as replaceBinary: avoid ETXTBSY on a running executable.
	if runtime.GOOS != "windows" {
		os.Remove(u.config.BinaryPath)
	}

	// Copy backup to current location
	src, err := os.Open(u.config.BackupPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(u.config.BinaryPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return err
	}

	// Set executable permissions on Unix
	if runtime.GOOS != "windows" {
		if err := os.Chmod(u.config.BinaryPath, 0755); err != nil {
			return err
		}
	}

	return nil
}
