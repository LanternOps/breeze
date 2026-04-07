package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/secmem"
)

var log = logging.L("updater")

// Config holds updater configuration
type Config struct {
	ServerURL      string
	AuthToken      *secmem.SecureString
	CurrentVersion string
	BinaryPath     string
	BackupPath     string
}

// Updater handles agent auto-updates
type Updater struct {
	config *Config
	client *http.Client
}

// New creates a new Updater
func New(cfg *Config) *Updater {
	return &Updater{
		config: cfg,
		client: &http.Client{Timeout: 5 * time.Minute},
	}
}

// ErrReadOnlyFS is returned when the binary path is on a read-only filesystem.
// Callers should treat this as a permanent failure and stop retrying.
var ErrReadOnlyFS = fmt.Errorf("binary path is on a read-only filesystem")

// ErrTextBusy is returned when the binary is currently executing (ETXTBSY).
// This is transient — the unlink-before-write in replaceBinary handles it,
// but this sentinel prevents misclassification as ErrReadOnlyFS.
var ErrTextBusy = fmt.Errorf("binary is currently executing")

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
	return fmt.Errorf("%w: %v", ErrReadOnlyFS, err)
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
	tempPath, checksum, err := u.downloadBinary(version)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}

	// 2. Verify checksum
	if err := u.verifyChecksum(tempPath, checksum); err != nil {
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
		if err := RestartWithHelper(tempPath, u.config.BinaryPath); err != nil {
			removeCleanup(tempPath)
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
	URL      string `json:"url"`
	Checksum string `json:"checksum"`
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
		return info, nil

	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		location, err := resp.Location()
		if err != nil {
			return downloadInfo{}, fmt.Errorf("download redirect missing location: %w", err)
		}
		checksum := resp.Header.Get("X-Checksum")
		if checksum == "" {
			return downloadInfo{}, fmt.Errorf("download redirect missing X-Checksum header")
		}
		return downloadInfo{
			URL:      location.String(),
			Checksum: checksum,
		}, nil

	default:
		return downloadInfo{}, fmt.Errorf("download info request failed with status %d", resp.StatusCode)
	}
}

// downloadBinary fetches download info from the API and then downloads the binary.
// Supports both legacy redirect responses and JSON info responses.
func (u *Updater) downloadBinary(version string) (string, string, error) {
	if u.config.AuthToken == nil {
		return "", "", fmt.Errorf("auth token not available")
	}
	// Step 1: Get download URL + checksum from API.
	infoURL := fmt.Sprintf("%s/api/v1/agent-versions/%s/download?platform=%s&arch=%s",
		u.config.ServerURL, version, runtime.GOOS, runtime.GOARCH)

	req, err := http.NewRequest("GET", infoURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+u.config.AuthToken.Reveal())

	resp, err := u.requestWithoutRedirect(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	info, err := u.parseDownloadInfo(resp)
	if err != nil {
		return "", "", err
	}

	// Step 2: Download the actual binary from the URL
	binReq, err := http.NewRequest("GET", info.URL, nil)
	if err != nil {
		return "", "", err
	}

	binResp, err := u.client.Do(binReq)
	if err != nil {
		return "", "", fmt.Errorf("failed to download binary: %w", err)
	}
	defer binResp.Body.Close()

	if binResp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("binary download failed with status %d", binResp.StatusCode)
	}

	// Write to temp file
	tempFile, err := os.CreateTemp("", "breeze-agent-*")
	if err != nil {
		return "", "", err
	}
	defer tempFile.Close()

	if _, err := io.Copy(tempFile, binResp.Body); err != nil {
		removeCleanup(tempFile.Name())
		return "", "", err
	}

	return tempFile.Name(), info.Checksum, nil
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
		if err := RestartWithHelper(tempPath, u.config.BinaryPath); err != nil {
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
