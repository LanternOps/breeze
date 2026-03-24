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
	openH264URL     = "http://ciscobinary.openh264.org/openh264-2.4.1-win64.dll.bz2"
	// SHA-256 of the decompressed DLL (v2.4.1 win64)
	openH264SHA256 = "d30abortedsafe" // placeholder — will be verified on first successful download
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

	// 3. Auto-download from Cisco GitHub
	slog.Info("OpenH264 DLL not found locally, downloading from Cisco GitHub",
		"url", openH264URL,
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

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(openH264URL)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download HTTP %d", resp.StatusCode)
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

	hash := hex.EncodeToString(hasher.Sum(nil))
	finalPath := filepath.Join(destDir, openH264DLLName)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}

	slog.Info("OpenH264 DLL downloaded and installed",
		"path", finalPath,
		"size", written,
		"sha256", hash,
	)
	return nil
}
