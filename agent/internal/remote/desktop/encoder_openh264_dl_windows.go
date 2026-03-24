//go:build windows

package desktop

import (
	"compress/bzip2"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

const (
	openH264DLLName = "openh264-2.4.1-win64.dll"
	openH264URL     = "https://github.com/nicedoc/openh264/releases/download/v2.4.1/openh264-2.4.1-win64.dll.bz2"
	// SHA-256 of the decompressed DLL (v2.4.1 win64), verified from Cisco's distribution.
	openH264SHA256 = "081b0c081480d177cbfddfbc90b1613640e702f875897b30d8de195cde73dd34"
	// Fallback URL — Cisco's official CDN (HTTP only, but we verify SHA-256).
	openH264FallbackURL = "http://ciscobinary.openh264.org/openh264-2.4.1-win64.dll.bz2"
)

// findOpenH264Library searches for the OpenH264 DLL on Windows.
// Search order: next to executable, agent data dir, auto-download.
func findOpenH264Library() (string, error) {
	// 1. Next to agent executable
	exePath, err := os.Executable()
	if err == nil {
		candidate := filepath.Join(filepath.Dir(exePath), openH264DLLName)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}

	// 2. Agent data directory
	dataDir := config.GetDataDir()
	candidate := filepath.Join(dataDir, openH264DLLName)
	if _, err := os.Stat(candidate); err == nil {
		return candidate, nil
	}

	// 3. Auto-download from Cisco
	slog.Info("OpenH264 DLL not found locally, downloading",
		"dest", candidate,
	)
	if err := downloadOpenH264DLL(dataDir); err != nil {
		return "", fmt.Errorf("auto-download OpenH264: %w", err)
	}
	return candidate, nil
}

func downloadOpenH264DLL(destDir string) error {
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("create dest dir: %w", err)
	}

	// Try Cisco CDN (most reliable for this specific binary)
	var lastErr error
	for _, url := range []string{openH264FallbackURL, openH264URL} {
		if err := downloadAndVerify(url, destDir); err != nil {
			slog.Warn("OpenH264 download failed, trying next source", "url", url, "error", err.Error())
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

func downloadAndVerify(url, destDir string) error {
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}

	// Decompress bzip2 stream and compute SHA-256 as we write
	bzReader := bzip2.NewReader(resp.Body)
	hasher := sha256.New()

	tmpPath := filepath.Join(destDir, openH264DLLName+".tmp")
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("create tmp file: %w", err)
	}

	written, err := io.Copy(f, io.TeeReader(bzReader, hasher))
	f.Close()
	if err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("decompress: %w", err)
	}

	// Verify SHA-256 before installing
	hash := hex.EncodeToString(hasher.Sum(nil))
	if hash != openH264SHA256 {
		os.Remove(tmpPath)
		return fmt.Errorf("SHA-256 mismatch: got %s, expected %s", hash, openH264SHA256)
	}

	finalPath := filepath.Join(destDir, openH264DLLName)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}

	slog.Info("OpenH264 DLL downloaded and verified",
		"path", finalPath,
		"size", written,
		"sha256", hash,
	)
	return nil
}
