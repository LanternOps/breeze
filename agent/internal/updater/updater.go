package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("updater")

// Config holds updater configuration
type Config struct {
	ServerURL      string
	AuthToken      string
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

// UpdateTo downloads and installs a new version
func (u *Updater) UpdateTo(version string) error {
	log.Info("starting update", "targetVersion", version)

	// 1. Download binary to temp file
	tempPath, checksum, err := u.downloadBinary(version)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}

	// 2. Verify checksum
	if err := u.verifyChecksum(tempPath, checksum); err != nil {
		os.Remove(tempPath)
		return fmt.Errorf("checksum verification failed: %w", err)
	}

	// 3. Backup current binary
	if err := u.backupCurrentBinary(); err != nil {
		os.Remove(tempPath)
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	// 4. On Windows, spawn a helper script that swaps the binary externally.
	//    The script handles: stop service -> copy new binary -> start service.
	//    The agent exits normally after spawning the script.
	if runtime.GOOS == "windows" {
		if err := RestartWithHelper(tempPath, u.config.BinaryPath); err != nil {
			os.Remove(tempPath)
			if rbErr := u.Rollback(); rbErr != nil {
				log.Error("rollback also failed", "originalError", err, "rollbackError", rbErr)
			}
			return fmt.Errorf("failed to spawn update helper: %w", err)
		}
		// Helper script will handle the rest -- agent exits via service stop.
		return nil
	}

	// 5. Non-Windows: replace binary inline and restart
	defer os.Remove(tempPath)
	if err := u.replaceBinary(tempPath); err != nil {
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
	// Step 1: Get download URL + checksum from API.
	infoURL := fmt.Sprintf("%s/api/v1/agent-versions/%s/download?platform=%s&arch=%s",
		u.config.ServerURL, version, runtime.GOOS, runtime.GOARCH)

	req, err := http.NewRequest("GET", infoURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+u.config.AuthToken)

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
		os.Remove(tempFile.Name())
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
	os.Remove(u.config.BackupPath)

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
		os.Remove(oldPath)
		if err := os.Rename(u.config.BinaryPath, oldPath); err != nil {
			return err
		}
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

	return nil
}

// UpdateFromURL downloads a binary directly from a URL (skipping the version-lookup
// API call used by UpdateTo). Used by dev_push for fast iteration.
func (u *Updater) UpdateFromURL(url, expectedChecksum string) error {
	log.Info("starting dev update from URL", "url", url)

	// 1. Download binary directly
	tempPath, err := u.downloadFromURL(url)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}

	// 2. Verify checksum
	if err := u.verifyChecksum(tempPath, expectedChecksum); err != nil {
		os.Remove(tempPath)
		return fmt.Errorf("checksum verification failed: %w", err)
	}

	// 3. Backup current binary
	if err := u.backupCurrentBinary(); err != nil {
		os.Remove(tempPath)
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	// 4. Windows: spawn helper script for binary swap
	if runtime.GOOS == "windows" {
		if err := RestartWithHelper(tempPath, u.config.BinaryPath); err != nil {
			os.Remove(tempPath)
			if rbErr := u.Rollback(); rbErr != nil {
				log.Error("rollback also failed", "originalError", err, "rollbackError", rbErr)
			}
			return fmt.Errorf("failed to spawn update helper: %w", err)
		}
		return nil
	}

	// 5. Non-Windows: replace binary inline and restart
	defer os.Remove(tempPath)
	if err := u.replaceBinary(tempPath); err != nil {
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
// The URL host must match the configured ServerURL to prevent credential leakage.
func (u *Updater) downloadFromURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("invalid download URL: %w", err)
	}
	serverParsed, err := url.Parse(u.config.ServerURL)
	if err != nil {
		return "", fmt.Errorf("invalid server URL: %w", err)
	}
	if parsed.Host != serverParsed.Host {
		return "", fmt.Errorf("download URL host %q does not match server %q", parsed.Host, serverParsed.Host)
	}

	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+u.config.AuthToken)

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
		os.Remove(tempFile.Name())
		return "", err
	}

	return tempFile.Name(), nil
}

// Rollback restores the backup binary
func (u *Updater) Rollback() error {
	log.Info("rolling back to previous version")

	if _, err := os.Stat(u.config.BackupPath); os.IsNotExist(err) {
		return fmt.Errorf("no backup found at %s", u.config.BackupPath)
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
