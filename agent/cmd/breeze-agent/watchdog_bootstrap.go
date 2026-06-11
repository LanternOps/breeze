package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// NOTE: Keep this URL base in sync with agent/internal/updater/pkg_darwin.go.
// Both point at the same GitHub releases. If one ever moves to an env var,
// migrate both call sites together.
const watchdogReleasesBase = "https://github.com/LanternOps/breeze/releases/download"

// watchdogBinaryName returns the filename for the watchdog binary on the given GOOS.
func watchdogBinaryName(goos string) string {
	if goos == "windows" {
		return "breeze-watchdog.exe"
	}
	return "breeze-watchdog"
}

// watchdogDownloadURL returns the GitHub release download URL for the watchdog
// binary matching the given agent version / OS / arch.
func watchdogDownloadURL(version, goos, goarch string) string {
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("%s/v%s/breeze-watchdog-%s-%s%s",
		watchdogReleasesBase, version, goos, goarch, ext)
}

func watchdogChecksumsURL(version string) string {
	return fmt.Sprintf("%s/v%s/checksums.txt", watchdogReleasesBase, version)
}

// locateSiblingWatchdog checks for the watchdog binary in the same directory
// as the agent binary. Returns (path, true) if found.
func locateSiblingWatchdog(agentPath string) (string, bool) {
	candidate := filepath.Join(filepath.Dir(agentPath), watchdogBinaryName(runtime.GOOS))
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() {
		return "", false
	}
	return candidate, true
}

const (
	watchdogMinSize         = 1 * 1024 * 1024 // 1 MB sanity check (real binary is several MB)
	watchdogDownloadTimeout = 60 * time.Second
)

// downloadWatchdog fetches the watchdog binary from url and writes it to destPath.
// The file is streamed to a sibling temp file and atomically renamed on success,
// so a partial download never leaves a broken binary behind. On unix the file is
// marked executable (0755).
func fetchWatchdogChecksum(checksumsURL, assetName string) (string, error) {
	client := &http.Client{Timeout: watchdogDownloadTimeout}
	resp, err := client.Get(checksumsURL)
	if err != nil {
		return "", fmt.Errorf("http get %s: %w", checksumsURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("http get %s: status %d", checksumsURL, resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		checksum := strings.ToLower(fields[0])
		name := strings.TrimPrefix(fields[1], "*")
		if name == assetName && len(checksum) == 64 {
			if _, err := hex.DecodeString(checksum); err != nil {
				return "", fmt.Errorf("invalid checksum for %s in %s: %w", assetName, checksumsURL, err)
			}
			return checksum, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("read %s: %w", checksumsURL, err)
	}
	return "", fmt.Errorf("checksum for %s not found in %s", assetName, checksumsURL)
}

func verifyFileSHA256(path, expected string) error {
	expected = strings.ToLower(strings.TrimSpace(expected))
	if len(expected) != 64 {
		return fmt.Errorf("expected checksum must be 64 hex characters")
	}
	if _, err := hex.DecodeString(expected); err != nil {
		return fmt.Errorf("expected checksum is not valid hex: %w", err)
	}

	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open downloaded file: %w", err)
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return fmt.Errorf("hash downloaded file: %w", err)
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expected, actual)
	}
	return nil
}

func downloadWatchdog(url, destPath, expectedSHA256 string) error {
	client := &http.Client{Timeout: watchdogDownloadTimeout}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("http get %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http get %s: status %d", url, resp.StatusCode)
	}

	tmpPath := destPath + ".download"
	tmp, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmpPath, err)
	}
	n, copyErr := io.Copy(tmp, resp.Body)
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("download body: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close %s: %w", tmpPath, closeErr)
	}
	if n < watchdogMinSize {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("downloaded body too small (%d bytes); URL likely returned an error page", n)
	}
	if err := verifyFileSHA256(tmpPath, expectedSHA256); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("verify checksum: %w", err)
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename %s -> %s: %w", tmpPath, destPath, err)
	}
	return nil
}

// bootstrapOptions is the inputs for bootstrapWatchdog. Kept as a struct so the
// callers on each OS stay short and the test helpers don't need long arg lists.
type bootstrapOptions struct {
	agentPath string // absolute path to the currently running agent binary
	version   string // agent version (main.version), e.g. "0.62.24" or "dev"
	goos      string // runtime.GOOS
	goarch    string // runtime.GOARCH

	// urlOverride, if non-empty, replaces the full download URL. Test-only.
	urlOverride string

	// checksumOverride, if non-empty, replaces checksums.txt lookup. Test-only.
	checksumOverride string
}

// bootstrapWatchdog resolves a watchdog binary (sibling first, GitHub download
// fallback) and then invokes `<watchdog> service install` to register it as a
// system service. All errors are returned — callers are expected to downgrade
// them to warnings so that a watchdog problem never aborts the agent install.
func bootstrapWatchdog(opts bootstrapOptions) error {
	watchdogPath, ok := locateSiblingWatchdog(opts.agentPath)
	if !ok {
		if opts.version == "" || opts.version == "dev" || strings.HasPrefix(opts.version, "dev-") {
			return fmt.Errorf("no sibling watchdog found and agent is a dev build (version=%q); run `breeze-watchdog service install` manually", opts.version)
		}
		url := opts.urlOverride
		if url == "" {
			url = watchdogDownloadURL(opts.version, opts.goos, opts.goarch)
		}
		checksum := opts.checksumOverride
		if checksum == "" {
			if opts.urlOverride != "" {
				return fmt.Errorf("watchdog checksum required when urlOverride is set")
			}
			assetName := filepath.Base(url)
			var err error
			checksum, err = fetchWatchdogChecksum(watchdogChecksumsURL(opts.version), assetName)
			if err != nil {
				return fmt.Errorf("fetch watchdog checksum: %w", err)
			}
		}
		watchdogPath = filepath.Join(filepath.Dir(opts.agentPath), watchdogBinaryName(opts.goos))
		fmt.Fprintf(os.Stderr, "Downloading watchdog from %s ...\n", url)
		if err := downloadWatchdog(url, watchdogPath, checksum); err != nil {
			return fmt.Errorf("download watchdog: %w", err)
		}
	}

	cmd := exec.Command(watchdogPath, "service", "install")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("run %s service install: %w", watchdogPath, err)
	}
	return nil
}
