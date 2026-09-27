//go:build windows

package desktop

import (
	"compress/bzip2"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

// getDataDirFn, verifyProgramDataPathFn and downloadOpenH264DLLFn are
// package-level seams so tests can exercise findOpenH264Library's
// fail-closed gates without a real agent data directory or network.
// Production always resolves through config.GetDataDir,
// config.VerifyProgramDataPath and downloadOpenH264DLL.
var (
	getDataDirFn            = config.GetDataDir
	verifyProgramDataPathFn = config.VerifyProgramDataPath
	downloadOpenH264DLLFn   = downloadOpenH264DLL
)

// refuseUntrustedDataDir returns a fail-closed error unless this process can
// itself verify, read-only, that dataDir and every directory above it up to
// the agent ProgramData root are real directories (not links) owned by
// SYSTEM, Administrators or TrustedInstaller that no other principal can
// write. The check runs in whichever process loads the codec: the
// desktop-session helpers that encode never run the service's startup
// repair pass, so they cannot rely on its result. A directory a foreign
// principal controls could swap the file between the SHA-256 check and the
// load, or interfere with the auto-download's temp-file-then-rename, so it
// is neither read from nor written into.
func refuseUntrustedDataDir(dataDir string) error {
	if err := verifyProgramDataPathFn(dataDir); err != nil {
		return fmt.Errorf("agent data directory %q is not verified as SYSTEM/Administrators-only — refusing to load or stage the OpenH264 codec from it: %w", dataDir, err)
	}
	return nil
}

// findOpenH264Library searches for the OpenH264 DLL on Windows.
// Search order: next to executable, agent data dir, auto-download.
//
// A candidate found next to the executable or in the agent data dir is only
// used after its SHA-256 matches the pinned release hash — previously
// os.Stat alone was enough to trust it, so a planted file of the right name
// in either location would be loaded into the LocalSystem service unverified
// (only the fresh-download path checked the hash). A name match with a
// mismatched hash is skipped, not deleted, and the search keeps going.
//
// The agent data dir candidates (2 and 3) additionally require the directory
// and the codec file itself to pass refuseUntrustedDataDir's read-only
// verification in this process. When the directory does not verify, the
// caller (loadOpenH264) degrades to the placeholder encoder instead of
// failing the agent — hardware encoding is disabled, not the process.
func findOpenH264Library() (string, error) {
	// 1. Next to agent executable
	exePath, err := os.Executable()
	if err == nil {
		candidate := filepath.Join(filepath.Dir(exePath), openH264DLLName)
		if ok, verr := verifyFileSHA256(candidate, openH264SHA256); verr == nil && ok {
			return candidate, nil
		} else if verr == nil && !ok {
			slog.Warn("OpenH264 DLL next to executable failed checksum verification, ignoring",
				"path", candidate,
			)
		}
	}

	// 2 & 3. Agent data directory — read or written only once this process
	// has verified its ownership and permissions itself.
	dataDir := getDataDirFn()
	if derr := refuseUntrustedDataDir(dataDir); derr != nil {
		slog.Warn("OpenH264: skipping the agent data directory — it did not verify as SYSTEM/Administrators-only",
			"dataDir", dataDir, "error", derr.Error(),
		)
		return "", fmt.Errorf("OpenH264 DLL not found next to the executable, and the agent data directory is not trusted: %w", derr)
	}

	candidate := filepath.Join(dataDir, openH264DLLName)
	if ferr := verifyProgramDataPathFn(candidate); ferr == nil {
		if ok, verr := verifyFileSHA256(candidate, openH264SHA256); verr == nil && ok {
			return candidate, nil
		} else if verr == nil && !ok {
			slog.Warn("OpenH264 DLL in agent data dir failed checksum verification, ignoring",
				"path", candidate,
			)
		}
	} else if !errors.Is(ferr, os.ErrNotExist) {
		slog.Warn("OpenH264 DLL in agent data dir did not verify as SYSTEM/Administrators-only, ignoring",
			"path", candidate, "error", ferr.Error(),
		)
	}

	// 3. Auto-download from Cisco
	slog.Info("OpenH264 DLL not found or not verified locally, downloading",
		"dest", candidate,
	)
	if err := downloadOpenH264DLLFn(dataDir); err != nil {
		return "", fmt.Errorf("auto-download OpenH264: %w", err)
	}
	if ferr := verifyProgramDataPathFn(candidate); ferr != nil {
		return "", fmt.Errorf("downloaded OpenH264 DLL did not verify as SYSTEM/Administrators-only: %w", ferr)
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
