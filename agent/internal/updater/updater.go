package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
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
	fmt.Printf("Starting update to version %s\n", version)

	// 1. Download binary to temp file
	tempPath, checksum, err := u.downloadBinary(version)
	if err != nil {
		return fmt.Errorf("failed to download binary: %w", err)
	}
	defer os.Remove(tempPath)

	// 2. Verify checksum
	if err := u.verifyChecksum(tempPath, checksum); err != nil {
		return fmt.Errorf("checksum verification failed: %w", err)
	}

	// 3. Backup current binary
	if err := u.backupCurrentBinary(); err != nil {
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	// 4. Replace current binary with new one
	if err := u.replaceBinary(tempPath); err != nil {
		// Attempt rollback
		u.Rollback()
		return fmt.Errorf("failed to replace binary: %w", err)
	}

	// 5. Restart the agent
	if err := Restart(); err != nil {
		// Attempt rollback
		u.Rollback()
		return fmt.Errorf("failed to restart: %w", err)
	}

	return nil
}

// downloadBinary downloads the new binary and returns temp path and checksum
func (u *Updater) downloadBinary(version string) (string, string, error) {
	url := fmt.Sprintf("%s/api/v1/agent-versions/%s/download?platform=%s&arch=%s",
		u.config.ServerURL, version, runtime.GOOS, runtime.GOARCH)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+u.config.AuthToken)

	resp, err := u.client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("download failed with status %d", resp.StatusCode)
	}

	// Get checksum from header
	checksum := resp.Header.Get("X-Checksum")
	if checksum == "" {
		return "", "", fmt.Errorf("no checksum in response")
	}

	// Create temp file
	tempFile, err := os.CreateTemp("", "breeze-agent-*")
	if err != nil {
		return "", "", err
	}
	defer tempFile.Close()

	// Copy body to temp file
	if _, err := io.Copy(tempFile, resp.Body); err != nil {
		os.Remove(tempFile.Name())
		return "", "", err
	}

	return tempFile.Name(), checksum, nil
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

// Rollback restores the backup binary
func (u *Updater) Rollback() error {
	fmt.Println("Rolling back to previous version...")

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
