//go:build !windows

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
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// Cisco OpenH264 v2.4.1 library names and SHA-256 hashes per platform.
// Hashes are of the decompressed library, verified from Cisco's distribution.
var openH264Variants = map[string]struct {
	libName     string
	sha256      string
	downloadURL string
	fallbackURL string
}{
	"darwin/arm64": {
		libName:     "libopenh264-2.4.1-mac-arm64.dylib",
		sha256:      "213ff93831cfa3dd6d7ad0c3a3403a6ceedf4ac1341e1278b5b869d42fefb496",
		downloadURL: "http://ciscobinary.openh264.org/libopenh264-2.4.1-mac-arm64.dylib.bz2",
		fallbackURL: "https://github.com/nicedoc/openh264/releases/download/v2.4.1/libopenh264-2.4.1-mac-arm64.dylib.bz2",
	},
	"darwin/amd64": {
		libName:     "libopenh264-2.4.1-mac-x64.dylib",
		sha256:      "cc0ba518a63791c37571f3c851f0aa03a4fbda5410acc214ecd4f24f8d1c478e",
		downloadURL: "http://ciscobinary.openh264.org/libopenh264-2.4.1-mac-x64.dylib.bz2",
		fallbackURL: "https://github.com/nicedoc/openh264/releases/download/v2.4.1/libopenh264-2.4.1-mac-x64.dylib.bz2",
	},
	"linux/amd64": {
		libName:     "libopenh264-2.4.1-linux64.7.so",
		sha256:      "1392d21466bc638e68151b716d5b2086d54cd812afd43253f1adb5b6e0185f51",
		downloadURL: "http://ciscobinary.openh264.org/libopenh264-2.4.1-linux64.7.so.bz2",
		fallbackURL: "https://github.com/nicedoc/openh264/releases/download/v2.4.1/libopenh264-2.4.1-linux64.7.so.bz2",
	},
	"linux/arm64": {
		libName:     "libopenh264-2.4.1-linux-arm64.7.so",
		sha256:      "e8ea7e42855ceb4a90e7bd0b3abeba0c58b5f97166e8b0a30eefd58e099557a4",
		downloadURL: "http://ciscobinary.openh264.org/libopenh264-2.4.1-linux-arm64.7.so.bz2",
		fallbackURL: "https://github.com/nicedoc/openh264/releases/download/v2.4.1/libopenh264-2.4.1-linux-arm64.7.so.bz2",
	},
}

// findOpenH264Library searches for the OpenH264 shared library on non-Windows.
// Search order: next to executable, agent data dir, standard paths, auto-download.
func findOpenH264Library() (string, error) {
	platform := runtime.GOOS + "/" + runtime.GOARCH
	variant, ok := openH264Variants[platform]
	if !ok {
		return "", fmt.Errorf("OpenH264: unsupported platform %s", platform)
	}

	// 1. Next to agent executable
	if exePath, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exePath), variant.libName)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}

	// 2. Agent data directory
	dataDir := config.GetDataDir()
	candidate := filepath.Join(dataDir, variant.libName)
	if _, err := os.Stat(candidate); err == nil {
		return candidate, nil
	}

	// 3. Standard library paths
	for _, dir := range []string{"/usr/lib", "/usr/local/lib", "/usr/lib64"} {
		c := filepath.Join(dir, variant.libName)
		if _, err := os.Stat(c); err == nil {
			return c, nil
		}
	}

	// 4. Auto-download from Cisco — try agent data dir first, fall back to
	// user-writable temp dir (helper processes run as the logged-in user and
	// cannot write to the root-owned agent data directory).
	downloadDir := dataDir
	if !isDirWritable(downloadDir) {
		slog.Warn("OpenH264: agent data dir not writable, using temp dir",
			"dataDir", dataDir)
		downloadDir = filepath.Join(os.TempDir(), "breeze-openh264")
	}
	slog.Info("OpenH264 library not found locally, downloading",
		"lib", variant.libName, "dest", downloadDir)
	if err := downloadOpenH264(variant, downloadDir); err != nil {
		return "", fmt.Errorf("auto-download OpenH264: %w", err)
	}
	return filepath.Join(downloadDir, variant.libName), nil
}

// isDirWritable checks if a directory exists and is writable by creating and
// immediately removing a temp file.
func isDirWritable(dir string) bool {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return false
	}
	f, err := os.CreateTemp(dir, ".breeze-write-check-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

func downloadOpenH264(v struct {
	libName     string
	sha256      string
	downloadURL string
	fallbackURL string
}, destDir string) error {
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("create dest dir: %w", err)
	}

	var lastErr error
	for _, url := range []string{v.downloadURL, v.fallbackURL} {
		if err := downloadAndVerifyLib(url, v.libName, v.sha256, destDir); err != nil {
			slog.Warn("OpenH264 download failed, trying next source", "url", url, "error", err.Error())
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

func downloadAndVerifyLib(url, libName, expectedHash, destDir string) error {
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}

	bzReader := bzip2.NewReader(resp.Body)
	hasher := sha256.New()

	tmpPath := filepath.Join(destDir, libName+".tmp")
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("create tmp file: %w", err)
	}

	// Limit decompressed size to prevent decompression bombs (libraries are ~2-5MB)
	const maxLibSize = 20 * 1024 * 1024
	written, err := io.Copy(f, io.LimitReader(io.TeeReader(bzReader, hasher), maxLibSize))
	f.Close()
	if err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("decompress: %w", err)
	}

	hash := hex.EncodeToString(hasher.Sum(nil))
	if hash != expectedHash {
		os.Remove(tmpPath)
		return fmt.Errorf("SHA-256 mismatch: got %s, expected %s", hash, expectedHash)
	}

	finalPath := filepath.Join(destDir, libName)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}

	slog.Info("OpenH264 library downloaded and installed",
		"path", finalPath, "size", written, "sha256", hash)
	return nil
}
