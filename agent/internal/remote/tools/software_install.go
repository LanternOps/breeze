package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	installTimeout     = 30 * time.Minute
	downloadTimeout    = 15 * time.Minute
	maxInstallFileSize = 500 * 1024 * 1024 // 500 MB
)

var checksumHexPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

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
	fileName, fileType, checksum, silentInstallArgs, softwareName, version, err := validateInstallInputs(fileName, fileType, checksum, silentInstallArgs, softwareName, version)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if err := validateDownloadURL(downloadUrl); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
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
	output, outputTruncated := sanitizeInstallerOutput(output)
	if err != nil {
		errMsg := err.Error()
		if outputTruncated {
			errMsg += " (installer output truncated)"
		}
		result := CommandResult{
			Status:     "failed",
			ExitCode:   exitCode,
			Stdout:     output,
			Error:      errMsg,
			DurationMs: time.Since(startTime).Milliseconds(),
		}
		return result
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
	if outputTruncated {
		result["outputTruncated"] = true
	}
	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func validateInstallInputs(fileName, fileType, checksum, silentInstallArgs, softwareName, version string) (string, string, string, string, string, string, error) {
	var truncated bool
	if fileName, truncated = truncateStringBytes(fileName, maxInstallMetadataBytes); truncated {
		return "", "", "", "", "", "", fmt.Errorf("fileName exceeds maximum size of %d bytes", maxInstallMetadataBytes)
	}
	if fileType, truncated = truncateStringBytes(fileType, maxInstallMetadataBytes); truncated {
		return "", "", "", "", "", "", fmt.Errorf("fileType exceeds maximum size of %d bytes", maxInstallMetadataBytes)
	}
	if !isSupportedInstallFileType(fileType) {
		return "", "", "", "", "", "", fmt.Errorf("unsupported fileType %q", fileType)
	}
	if err := validateInstallFileName(fileName, fileType); err != nil {
		return "", "", "", "", "", "", err
	}
	if checksum, truncated = truncateStringBytes(checksum, maxInstallMetadataBytes); truncated {
		return "", "", "", "", "", "", fmt.Errorf("checksum exceeds maximum size of %d bytes", maxInstallMetadataBytes)
	}
	if checksum != "" && !checksumHexPattern.MatchString(checksum) {
		return "", "", "", "", "", "", fmt.Errorf("checksum must be a 64-character SHA-256 hex string")
	}
	if softwareName, truncated = truncateStringBytes(softwareName, maxInstallMetadataBytes); truncated {
		return "", "", "", "", "", "", fmt.Errorf("softwareName exceeds maximum size of %d bytes", maxInstallMetadataBytes)
	}
	if version, truncated = truncateStringBytes(version, maxInstallMetadataBytes); truncated {
		return "", "", "", "", "", "", fmt.Errorf("version exceeds maximum size of %d bytes", maxInstallMetadataBytes)
	}
	if silentInstallArgs, truncated = truncateStringBytes(silentInstallArgs, maxInstallArgBytes); truncated {
		return "", "", "", "", "", "", fmt.Errorf("silentInstallArgs exceeds maximum size of %d bytes", maxInstallArgBytes)
	}
	if err := validateSilentInstallArgs(silentInstallArgs); err != nil {
		return "", "", "", "", "", "", err
	}
	if strings.EqualFold(strings.TrimSpace(fileType), "msi") {
		if err := validateMSIInstallArgs(silentInstallArgs); err != nil {
			return "", "", "", "", "", "", err
		}
	}

	return fileName, fileType, checksum, silentInstallArgs, softwareName, version, nil
}

func isSupportedInstallFileType(fileType string) bool {
	switch strings.ToLower(strings.TrimSpace(fileType)) {
	case "exe", "msi", "deb", "pkg", "dmg":
		return true
	default:
		return false
	}
}

func validateInstallFileName(fileName, fileType string) error {
	fileName = strings.TrimSpace(fileName)
	if fileName == "" {
		return fmt.Errorf("fileName is required")
	}
	if strings.Contains(fileName, "\x00") {
		return fmt.Errorf("fileName contains invalid null byte")
	}

	ext := strings.ToLower(filepath.Ext(fileName))
	expected := "." + strings.ToLower(strings.TrimSpace(fileType))
	if ext != expected {
		return fmt.Errorf("fileName extension %q does not match fileType %q", ext, fileType)
	}
	return nil
}

func validateSilentInstallArgs(args string) error {
	if strings.ContainsAny(args, "\x00\r\n") {
		return fmt.Errorf("silentInstallArgs contains invalid control characters")
	}
	if strings.Count(args, "\"")%2 != 0 {
		return fmt.Errorf("silentInstallArgs contains unmatched quotes")
	}
	return nil
}

func validateMSIInstallArgs(args string) error {
	parts := splitCommandLine(args)
	if len(parts) > 0 && strings.EqualFold(filepath.Base(parts[0]), "msiexec") {
		parts = parts[1:]
	}
	for _, part := range parts {
		switch strings.ToLower(strings.TrimSpace(part)) {
		case "/x", "-x", "/uninstall", "-uninstall", "/a", "-a", "/f", "-f":
			return fmt.Errorf("silentInstallArgs contains unsupported MSI action %q", part)
		}
	}
	return nil
}

func validateDownloadURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("downloadUrl is invalid: %w", err)
	}
	if !strings.EqualFold(parsed.Scheme, "https") {
		return fmt.Errorf("downloadUrl must use HTTPS")
	}
	if parsed.Host == "" {
		return fmt.Errorf("downloadUrl must include a host")
	}
	if parsed.User != nil {
		return fmt.Errorf("downloadUrl must not include userinfo")
	}
	return nil
}

func newInstallerHTTPClient() *http.Client {
	return &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("stopped after too many redirects")
			}
			if err := validateDownloadURL(req.URL.String()); err != nil {
				return fmt.Errorf("redirect blocked: %w", err)
			}
			return nil
		},
	}
}

func downloadFile(url, destPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), downloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	resp, err := newInstallerHTTPClient().Do(req)
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
		cmd = exec.CommandContext(ctx, "msiexec", buildMSIExecArgs(localPath, silentInstallArgs)...)

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

func buildMSIExecArgs(localPath, silentInstallArgs string) []string {
	args := strings.ReplaceAll(silentInstallArgs, "{file}", localPath)
	if strings.TrimSpace(args) == "" {
		return []string{"/i", localPath, "/qn", "/norestart"}
	}

	parts := splitCommandLine(args)
	if len(parts) > 0 && strings.EqualFold(filepath.Base(parts[0]), "msiexec") {
		parts = parts[1:]
	}

	referencesFile := false
	for _, part := range parts {
		if part == localPath {
			referencesFile = true
			break
		}
	}
	if !referencesFile {
		parts = append([]string{"/i", localPath}, parts...)
	}
	if len(parts) == 0 {
		return []string{"/i", localPath, "/qn", "/norestart"}
	}
	return parts
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
