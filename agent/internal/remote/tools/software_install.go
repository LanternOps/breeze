package tools

import (
	"context"
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

const (
	installTimeout    = 30 * time.Minute
	downloadTimeout   = 15 * time.Minute
	maxInstallFileSize = 500 * 1024 * 1024 // 500 MB
)

// InstallSoftware downloads a package from a presigned URL, verifies its checksum,
// and executes it with the provided silent install arguments.
func InstallSoftware(payload map[string]any) CommandResult {
	startTime := time.Now()

	downloadUrl, errResult := RequirePayloadString(payload, "downloadUrl")
	if errResult != nil {
		return *errResult
	}
	fileName := GetPayloadString(payload, "fileName", "installer")
	fileType := GetPayloadString(payload, "fileType", "exe")
	checksum := GetPayloadString(payload, "checksum", "")
	silentInstallArgs := GetPayloadString(payload, "silentInstallArgs", "")
	softwareName := GetPayloadString(payload, "softwareName", "")
	version := GetPayloadString(payload, "version", "")

	// Validate URL scheme
	if !strings.HasPrefix(downloadUrl, "https://") && !strings.HasPrefix(downloadUrl, "http://") {
		return NewErrorResult(fmt.Errorf("downloadUrl must use HTTPS or HTTP scheme"), time.Since(startTime).Milliseconds())
	}

	// Download to temp directory
	tempDir, err := os.MkdirTemp("", "breeze-sw-install-*")
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to create temp dir: %w", err), time.Since(startTime).Milliseconds())
	}
	defer os.RemoveAll(tempDir)

	localPath := filepath.Join(tempDir, filepath.Base(fileName))

	if err := downloadFile(downloadUrl, localPath); err != nil {
		return NewErrorResult(fmt.Errorf("download failed: %w", err), time.Since(startTime).Milliseconds())
	}

	// Verify checksum if provided
	if checksum != "" {
		actualChecksum, err := computeSHA256(localPath)
		if err != nil {
			return NewErrorResult(fmt.Errorf("checksum computation failed: %w", err), time.Since(startTime).Milliseconds())
		}
		if !strings.EqualFold(actualChecksum, checksum) {
			return NewErrorResult(
				fmt.Errorf("checksum mismatch: expected %s, got %s", checksum, actualChecksum),
				time.Since(startTime).Milliseconds(),
			)
		}
	}

	// Execute installer
	exitCode, output, err := executeInstaller(localPath, fileType, silentInstallArgs)
	if err != nil {
		return CommandResult{
			Status:     "failed",
			ExitCode:   exitCode,
			Stdout:     output,
			Error:      err.Error(),
			DurationMs: time.Since(startTime).Milliseconds(),
		}
	}

	result := map[string]any{
		"softwareName": softwareName,
		"version":      version,
		"fileType":     fileType,
		"exitCode":     exitCode,
		"output":       output,
		"action":       "install",
		"success":      true,
	}
	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func downloadFile(url, destPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), downloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d from download URL", resp.StatusCode)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	defer f.Close()

	// Limit to max file size to prevent disk exhaustion
	limited := io.LimitReader(resp.Body, maxInstallFileSize+1)
	n, err := io.Copy(f, limited)
	if err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	if n > maxInstallFileSize {
		return fmt.Errorf("file exceeds maximum size of %d bytes", maxInstallFileSize)
	}

	return nil
}

func computeSHA256(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func executeInstaller(localPath, fileType, silentInstallArgs string) (int, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), installTimeout)
	defer cancel()

	var cmd *exec.Cmd

	switch {
	case fileType == "msi" && runtime.GOOS == "windows":
		// Replace {file} placeholder with actual path
		args := strings.ReplaceAll(silentInstallArgs, "{file}", localPath)
		if args == "" {
			args = fmt.Sprintf(`msiexec /i "%s" /qn /norestart`, localPath)
		}
		// Parse msiexec args: if args starts with "msiexec", use it directly
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(args)), "msiexec") {
			parts := splitCommandLine(args)
			if len(parts) > 1 {
				cmd = exec.CommandContext(ctx, parts[0], parts[1:]...)
			} else {
				cmd = exec.CommandContext(ctx, parts[0])
			}
		} else {
			cmd = exec.CommandContext(ctx, "msiexec", splitCommandLine(args)...)
		}

	case fileType == "exe" && runtime.GOOS == "windows":
		if silentInstallArgs != "" {
			args := strings.ReplaceAll(silentInstallArgs, "{file}", localPath)
			parts := splitCommandLine(args)
			cmd = exec.CommandContext(ctx, localPath, parts...)
		} else {
			cmd = exec.CommandContext(ctx, localPath)
		}

	case fileType == "deb" && runtime.GOOS == "linux":
		cmd = exec.CommandContext(ctx, "dpkg", "-i", localPath)

	case fileType == "pkg" && runtime.GOOS == "darwin":
		cmd = exec.CommandContext(ctx, "installer", "-pkg", localPath, "-target", "/")

	case fileType == "dmg" && runtime.GOOS == "darwin":
		// Mount, find .app or .pkg, install, unmount
		return installDMG(ctx, localPath)

	default:
		return 1, "", fmt.Errorf("unsupported file type %q on %s", fileType, runtime.GOOS)
	}

	output, err := cmd.CombinedOutput()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return 1, string(output), err
		}
	}

	// MSI exit codes: 0 = success, 3010 = success pending reboot
	if fileType == "msi" && (exitCode == 0 || exitCode == 3010) {
		return exitCode, string(output), nil
	}

	if exitCode != 0 {
		return exitCode, string(output), fmt.Errorf("installer exited with code %d", exitCode)
	}

	return 0, string(output), nil
}

func installDMG(ctx context.Context, dmgPath string) (int, string, error) {
	// Mount
	mountPoint := filepath.Join(os.TempDir(), "breeze-dmg-mount")
	os.MkdirAll(mountPoint, 0700)

	mountCmd := exec.CommandContext(ctx, "hdiutil", "attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse", "-quiet")
	if out, err := mountCmd.CombinedOutput(); err != nil {
		return 1, string(out), fmt.Errorf("failed to mount DMG: %w", err)
	}
	defer exec.Command("hdiutil", "detach", mountPoint, "-quiet").Run()

	// Look for .pkg first, then .app
	entries, _ := os.ReadDir(mountPoint)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".pkg") {
			pkgPath := filepath.Join(mountPoint, entry.Name())
			cmd := exec.CommandContext(ctx, "installer", "-pkg", pkgPath, "-target", "/")
			out, err := cmd.CombinedOutput()
			exitCode := 0
			if err != nil {
				if exitErr, ok := err.(*exec.ExitError); ok {
					exitCode = exitErr.ExitCode()
				}
				if exitCode != 0 {
					return exitCode, string(out), fmt.Errorf("pkg installer exited with code %d", exitCode)
				}
				return 1, string(out), err
			}
			return 0, string(out), nil
		}
	}

	// Copy .app to /Applications
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".app") {
			src := filepath.Join(mountPoint, entry.Name())
			dst := filepath.Join("/Applications", entry.Name())
			cmd := exec.CommandContext(ctx, "cp", "-R", src, dst)
			out, err := cmd.CombinedOutput()
			if err != nil {
				return 1, string(out), fmt.Errorf("failed to copy app: %w", err)
			}
			return 0, string(out), nil
		}
	}

	return 1, "", fmt.Errorf("no .pkg or .app found in DMG")
}

// splitCommandLine splits a command-line string into arguments, respecting double-quoted strings.
func splitCommandLine(s string) []string {
	var args []string
	var current strings.Builder
	inQuote := false

	for _, r := range s {
		switch {
		case r == '"':
			inQuote = !inQuote
		case r == ' ' && !inQuote:
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	return args
}
