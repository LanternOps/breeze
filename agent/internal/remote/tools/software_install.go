package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/netpolicy"
	"github.com/breeze-rmm/agent/internal/procoutput"
	"github.com/breeze-rmm/agent/internal/updater"
)

const (
	installTimeout  = 30 * time.Minute
	downloadTimeout = 15 * time.Minute

	// maxManagedSoftwareOrigins mirrors the server-side bound on
	// softwareDownloadPolicy.approvedPrivateOrigins (32). A longer list is not
	// something the API can produce, so it is treated as a malformed policy.
	maxManagedSoftwareOrigins = 32
)

// maxInstallFileSize bounds both the netpolicy transport (Policy.
// MaxResponseBytes) and the explicit CopyBounded call in downloadFile. A var
// (not a const), matching updater.maxUpdateBinaryBytes, solely so tests can
// shrink it — moving the real 500 MiB through a unit test is impractical.
// Production behavior is unchanged.
var maxInstallFileSize int64 = 500 * 1024 * 1024 // 500 MB

var checksumHexPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

// InstallSoftware downloads a package from a presigned URL, verifies its checksum,
// and executes it with the provided silent install arguments.
func InstallSoftware(payload map[string]any) (result CommandResult) {
	startTime := time.Now()
	// Stamp StartedAt on every return path so the server can record the
	// real start instead of reconstructing it from durationMs.
	defer func() {
		result.StartedAt = startTime.UTC().Format(time.RFC3339Nano)
	}()

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

	// Detection rules (#2022): evaluated against the device's real state so the
	// reported status reflects whether the app is actually present rather than
	// just the installer exit code.
	detectionRules := parseDetectionRules(payload)
	forceReinstall := GetPayloadBool(payload, "forceReinstall", false)

	// Pre-install gate: when a detection rule is configured and the package is
	// already present, skip the download+install entirely (unless the deployment
	// forces a reinstall). Unsupported rule types on this platform can't be
	// evaluated, so we fall through and install rather than guessing.
	if len(detectionRules) > 0 && !forceReinstall {
		if pre := EvaluateDetectionRules(detectionRules); pre.Supported && pre.Detected {
			return NewSuccessResult(map[string]any{
				"softwareName":       softwareName,
				"version":            version,
				"fileType":           fileType,
				"action":             "install",
				"success":            true,
				"skipped":            true,
				"detectionPerformed": true,
				"detectionSatisfied": true,
				"detail":             "already installed; " + pre.Detail,
			}, time.Since(startTime).Milliseconds())
		}
	}

	// Outbound network policy (Wave 6 Task 5, security remediation). The
	// destination is attacker-influenced and carries an executable payload, so
	// every check below — scheme, host shape, address classification at dial
	// time, on every redirect hop — belongs to netpolicy, not to this file.
	// There is never an unenforced fallback client (mirrors updater.New's
	// fail-closed posture); see managedSoftwareClient for the ONE narrow
	// degradation, which removes permissions rather than granting any.
	policy := managedSoftwarePolicy(parseDownloadPolicy(payload))
	if err := netpolicy.ValidateURL(downloadUrl, policy); err != nil {
		return NewErrorResult(
			fmt.Errorf("downloadUrl rejected by network policy: %s", safeDownloadError(err)),
			time.Since(startTime).Milliseconds(),
		)
	}
	client, err := managedSoftwareClient(policy)
	if err != nil {
		return NewErrorResult(
			fmt.Errorf("managed software network policy unavailable: %s", safeDownloadError(err)),
			time.Since(startTime).Milliseconds(),
		)
	}

	// Download to temp directory
	tempDir, err := os.MkdirTemp("", "breeze-sw-install-*")
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to create temp dir: %w", err), time.Since(startTime).Milliseconds())
	}
	defer os.RemoveAll(tempDir)

	localPath := filepath.Join(tempDir, filepath.Base(fileName))

	if err := downloadFile(client, downloadUrl, localPath); err != nil {
		// safeDownloadError, never %w: net/http wraps every transport failure
		// in *url.Error, whose message repeats the full request URL — and a
		// managed software URL is typically presigned, carrying a capability
		// query string that must never reach a log or a command result.
		return NewErrorResult(
			fmt.Errorf("download failed: %s", safeDownloadError(err)),
			time.Since(startTime).Milliseconds(),
		)
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

	successPayload := map[string]any{
		"softwareName": softwareName,
		"version":      version,
		"fileType":     fileType,
		"exitCode":     exitCode,
		"output":       output,
		"action":       "install",
		"success":      true,
	}
	if outputTruncated {
		successPayload["outputTruncated"] = true
	}

	return applyPostInstallDetection(successPayload, exitCode, output, detectionRules, time.Since(startTime).Milliseconds())
}

// applyPostInstallDetection decides the final install result from the device's
// REAL state when detection rules are configured (#2022). The installer's exit
// code alone is not trusted: an installer can exit 0 yet leave nothing behind.
//
// Three outcomes:
//   - supported + detected   → success (the install verified).
//   - supported + !detected  → failed ("reported success but detection rule
//     was not satisfied") — the marquee guarantee of this feature.
//   - unsupported on platform → keep the exit-code success result and note that
//     detection was not performed (never silently flip to pass/fail).
//
// With no rules it is a plain exit-code success. successPayload is mutated with
// detection metadata for the success/unsupported paths.
func applyPostInstallDetection(successPayload map[string]any, exitCode int, output string, rules []DetectionRule, durationMs int64) CommandResult {
	if len(rules) == 0 {
		return NewSuccessResult(successPayload, durationMs)
	}

	post := EvaluateDetectionRules(rules)
	if !post.Supported {
		successPayload["detectionPerformed"] = false
		successPayload["detail"] = post.Detail
		return NewSuccessResult(successPayload, durationMs)
	}

	successPayload["detectionPerformed"] = true
	successPayload["detectionSatisfied"] = post.Detected
	if !post.Detected {
		return CommandResult{
			Status:     "failed",
			ExitCode:   exitCode,
			Stdout:     output,
			Error:      "installer reported success but detection rule was not satisfied: " + post.Detail,
			DurationMs: durationMs,
		}
	}
	successPayload["detail"] = post.Detail
	return NewSuccessResult(successPayload, durationMs)
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

// managedSoftwarePolicy is the outbound network policy for every managed
// software download. Managed software URLs are vendor CDNs or customer-hosted
// repositories delivering executable payloads, so:
//
//   - Purpose ManagedSoftwareDownload requires HTTPS unconditionally — the
//     cleartext exception exists only for a configured control-plane origin,
//     which this purpose never has;
//   - ApprovedPrivateOrigins is the tenant's org ∪ site allowlist as delivered
//     with the command. It grants reachability to an RFC1918/ULA/CGNAT address
//     at that EXACT origin, and nothing else: no loopback, link-local,
//     metadata or reserved destination is reachable however it is spelled or
//     whatever the allowlist says;
//   - the redirect chain is capped at 10 hops and re-validated (and stripped
//     of credentials on any origin change) on every one of them;
//   - the whole exchange, body included, is bounded by 15 minutes and
//     maxInstallFileSize.
func managedSoftwarePolicy(approvedPrivateOrigins []string) netpolicy.Policy {
	return netpolicy.Policy{
		Purpose:                netpolicy.ManagedSoftwareDownload,
		ApprovedPrivateOrigins: approvedPrivateOrigins,
		MaxRedirects:           10,
		RequestTimeout:         downloadTimeout,
		MaxResponseBytes:       maxInstallFileSize,
	}
}

// degradedOriginSetLogged bounds the "allowlist unusable" warning to one line
// per distinct reason for the life of the process. A hand-edited settings row
// is delivered with EVERY managed-software command, so an unbounded warn would
// ship one line per install attempt forever (log shipping defaults to warn).
// Same latch shape as heartbeat's manifest-trust rejection latches.
var degradedOriginSetLogged atomic.Pointer[string]

// logDegradedOriginSet is a var so tests can observe the single line. Takes an
// already-bounded reason string, never an error: an origin-set failure reason
// must not be able to carry a URL into the shipped log.
var logDegradedOriginSet = func(reason string) {
	slog.Warn("managed software approved-origin allowlist unusable; continuing with an EMPTY approved set "+
		"(public destinations still install, every private destination fails closed)",
		"reason", reason)
}

// managedSoftwareClient builds the enforcing client for one managed-software
// download, DEGRADING rather than dying when the delivered allowlist cannot be
// turned into an origin set.
//
// netpolicy.newOriginSet aborts on the FIRST unparseable entry, so before this
// existed a single bad row — `https://192.168.1.x`, which the server-side
// validator used to accept (finding C1) — made netpolicy.NewClient error and
// failed EVERY managed install carrying that org/site allowlist, including
// public-CDN installs that need no allowlist entry at all. One hand-edited
// settings row must not be able to deny an org all software deployment.
//
// The degradation only ever REMOVES permission: an empty approved-private set
// is the same posture as "no policy delivered" (parseDownloadPolicy's own
// reject path), so public destinations still work and every private
// destination fails closed at dial time with private_address_not_allowed.
// Nothing else about the policy is relaxed — purpose, redirect cap, timeout
// and byte bound are carried over unchanged — and if construction fails even
// with an empty set (a shape error this file controls, not the server) the
// install still fails closed.
func managedSoftwareClient(policy netpolicy.Policy) (*http.Client, error) {
	client, err := netpolicy.NewClient(policy)
	if err == nil {
		return client, nil
	}

	reason := safeDownloadError(err)
	if prev := degradedOriginSetLogged.Load(); prev == nil || *prev != reason {
		if degradedOriginSetLogged.CompareAndSwap(prev, &reason) {
			logDegradedOriginSet(reason)
		}
	}

	degraded := policy
	degraded.ApprovedPrivateOrigins = nil
	return netpolicy.NewClient(degraded)
}

// parseDownloadPolicy strictly parses the server-supplied `downloadPolicy`
// command field into the approved private origins it names.
//
// Strict means all-or-nothing: any deviation from the exact expected shape
// yields NO approved origins rather than a partially-trusted list. The
// resulting posture is the one the brief requires — a MISSING or malformed
// policy stays compatible for a destination that resolves entirely public
// (which needs no allowlist entry at all), while every private answer fails
// closed at dial time with private_address_not_allowed.
//
// A well-formed policy naming an unparseable origin lands in the same place by
// a different route: netpolicy.NewClient rejects the whole set, and
// managedSoftwareClient then degrades to an EMPTY approved set. Both paths
// converge on "no private destination is reachable", which is the only safe
// reading of an allowlist the agent cannot understand. What neither path does
// is fail the install outright — a hand-edited settings row must not be able
// to deny an org every managed-software deployment (finding C1).
func parseDownloadPolicy(payload map[string]any) []string {
	raw, present := payload["downloadPolicy"]
	if !present || raw == nil {
		return nil
	}

	reject := func(reason string) []string {
		// No URL, no origin text, no payload echo — a bounded reason only.
		slog.Warn("managed software downloadPolicy rejected; private destinations will be refused",
			"reason", reason)
		return nil
	}

	obj, ok := raw.(map[string]any)
	if !ok {
		return reject("not_an_object")
	}
	if !downloadPolicyVersionIsOne(obj["version"]) {
		return reject("unsupported_version")
	}
	list, ok := obj["approvedPrivateOrigins"].([]any)
	if !ok {
		return reject("origins_not_a_list")
	}
	if len(list) > maxManagedSoftwareOrigins {
		return reject("too_many_origins")
	}

	origins := make([]string, 0, len(list))
	for _, entry := range list {
		s, ok := entry.(string)
		if !ok {
			return reject("origin_not_a_string")
		}
		if strings.TrimSpace(s) == "" {
			return reject("empty_origin")
		}
		origins = append(origins, strings.TrimSpace(s))
	}
	return origins
}

// downloadPolicyVersionIsOne accepts only version 1, in whichever numeric
// shape the JSON decoder produced (float64 over the wire; int/json.Number are
// accepted defensively so an in-process caller cannot accidentally downgrade
// itself to "no policy").
func downloadPolicyVersionIsOne(v any) bool {
	switch n := v.(type) {
	case float64:
		return n == 1
	case int:
		return n == 1
	case int64:
		return n == 1
	case json.Number:
		i, err := n.Int64()
		return err == nil && i == 1
	default:
		return false
	}
}

// safeDownloadError renders a download failure without leaking the request URL.
//
// It DELEGATES to updater.SafeDownloadErrorFields rather than re-implementing
// the errors.As dance. It used to be a fork of it, and the fork had already
// drifted: it dereferenced urlErr.Err without a nil check, and a future fix to
// one copy would silently not reach the other. There is exactly one
// implementation of this redaction in the agent now.
//
// The bounded reason is returned bare (not prefixed) because every caller here
// interpolates it into its own "download failed: %s" message and the existing
// tests match on the reason token itself.
func safeDownloadError(err error) string {
	if err == nil {
		return ""
	}
	_, value := updater.SafeDownloadErrorFields(err)
	return value
}

// downloadFile fetches the package with the caller-supplied policy client.
// The client is a required parameter (never constructed here) so no code path
// can accidentally download managed software on an unenforced transport.
func downloadFile(client *http.Client, rawURL, destPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), downloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
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

	// CopyBounded, not io.Copy: the transport already caps the response body
	// via Policy.MaxResponseBytes, but a caller passing a non-netpolicy client
	// (or a future policy change) must not be able to reintroduce an unbounded
	// write to disk.
	if _, err := netpolicy.CopyBounded(f, resp.Body, maxInstallFileSize); err != nil {
		return fmt.Errorf("write file: %w", err)
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

	cmd.Env = procoutput.ApplyEnv(os.Environ())

	output, err := cmd.CombinedOutput()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return 1, procoutput.BytesToUTF8(output), err
		}
	}

	if installerExitIndicatesSuccess(fileType, exitCode) {
		return exitCode, procoutput.BytesToUTF8(output), nil
	}

	return exitCode, procoutput.BytesToUTF8(output), fmt.Errorf("installer exited with code %d", exitCode)
}

// installerExitIndicatesSuccess reports whether an installer exit code means the
// install succeeded. 0 is universal success. 3010 (ERROR_SUCCESS_REBOOT_REQUIRED)
// and 1641 (ERROR_SUCCESS_REBOOT_INITIATED) are Windows installer "success, a
// reboot is pending/underway" codes returned by both MSI and many EXE installers.
// Previously only MSI 3010 was honored, so a reboot-pending EXE install — and any
// MSI returning 1641 — was wrongly reported as failed (#2022).
func installerExitIndicatesSuccess(fileType string, exitCode int) bool {
	if exitCode == 0 {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(fileType)) {
	case "exe", "msi":
		return exitCode == 3010 || exitCode == 1641
	default:
		return false
	}
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
		return 1, procoutput.BytesToUTF8(out), fmt.Errorf("failed to mount DMG: %w", err)
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
					return exitCode, procoutput.BytesToUTF8(out), fmt.Errorf("pkg installer exited with code %d", exitCode)
				}
				return 1, procoutput.BytesToUTF8(out), err
			}
			return 0, procoutput.BytesToUTF8(out), nil
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
				return 1, procoutput.BytesToUTF8(out), fmt.Errorf("failed to copy app: %w", err)
			}
			return 0, procoutput.BytesToUTF8(out), nil
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
