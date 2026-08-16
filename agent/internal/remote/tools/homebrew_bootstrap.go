package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

const (
	// homebrewBootstrapTimeout is generous on purpose: a cold Homebrew
	// install compiles/downloads a fair amount on a slow link, and the
	// installer also has to wait on the console user's sudo/Command Line
	// Tools prompts.
	homebrewBootstrapTimeout = 20 * time.Minute

	// homebrewInstallerDownloadTimeout bounds the fetch of install.sh alone.
	homebrewInstallerDownloadTimeout = 2 * time.Minute

	// maxHomebrewInstallerBytes bounds the download. The real install.sh is
	// ~33 KB; 4 MiB is a decisive ceiling that no legitimate version
	// approaches.
	maxHomebrewInstallerBytes = 4 * 1024 * 1024

	homebrewInstallerHost     = "raw.githubusercontent.com"
	homebrewInstallerPathRoot = "/Homebrew/install/"
)

// bootstrapTempBaseDir is "/tmp" ON PURPOSE — do not "fix" this back to
// os.MkdirTemp("") / the default TMPDIR.
//
// The agent runs as a root LaunchDaemon, whose $TMPDIR is a per-user confined
// directory (/var/folders/<xx>/<yyy>/T/) that is 0700 and owned by root. The
// verified installer is executed as the CONSOLE user via sudo, and that user
// cannot traverse root's confined TMPDIR — bash would fail with "permission
// denied" on the parent no matter how permissive the leaf file is. /tmp is
// world-traversable and sticky, and MkdirTemp still creates a fresh
// root-owned directory with O_EXCL and an unguessable name, so every
// hardening property of the original placement survives.
//
// A var, not a const, only so tests can point it at t.TempDir().
var bootstrapTempBaseDir = "/tmp"

// bootstrapDeps isolates every OS- and network-facing thing
// BootstrapHomebrew needs, so the whole command is unit-testable without
// touching the network, sudo, or a real console session.
type bootstrapDeps struct {
	goos        string
	download    func(url string) ([]byte, error)
	brewPath    func() (string, error)
	consoleUser func() (*user.User, error)
	runScript   func(scriptPath string, u *user.User) (string, int, error)
}

func defaultBootstrapDeps() bootstrapDeps {
	return bootstrapDeps{
		goos:        runtime.GOOS,
		download:    downloadHomebrewInstaller,
		brewPath:    patching.BrewBinaryPath,
		consoleUser: patching.ActiveConsoleUser,
		runScript:   runHomebrewInstaller,
	}
}

// BootstrapHomebrew installs Homebrew on a macOS endpoint from a pinned,
// checksum-verified copy of the official installer.
//
// This is deliberately NOT a general "run a script from a URL" primitive:
//
//   - the URL must be https://raw.githubusercontent.com/Homebrew/install/<ref>/…
//     with an immutable <ref> (a commit sha or a tag — never HEAD/master/main),
//   - the sha256 the server pins is verified BEFORE anything is executed, and a
//     mismatch aborts without ever handing the bytes to a shell,
//   - the script runs as the active console user (Homebrew refuses to run as
//     root), never as the agent's root process.
func BootstrapHomebrew(payload map[string]any) CommandResult {
	return bootstrapHomebrew(payload, defaultBootstrapDeps())
}

func bootstrapHomebrew(payload map[string]any, deps bootstrapDeps) (result CommandResult) {
	startTime := time.Now()
	defer func() {
		result.StartedAt = startTime.UTC().Format(time.RFC3339Nano)
	}()
	fail := func(err error) CommandResult {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if deps.goos != "darwin" {
		return fail(fmt.Errorf("homebrew bootstrap is macOS-only (this device runs %s)", deps.goos))
	}

	installerURL, errResult := RequirePayloadString(payload, "installerUrl")
	if errResult != nil {
		return *errResult
	}
	installerSha, errResult := RequirePayloadString(payload, "installerSha256")
	if errResult != nil {
		return *errResult
	}
	if !checksumHexPattern.MatchString(installerSha) {
		return fail(fmt.Errorf("installerSha256 must be a 64-character hex sha256"))
	}
	if err := validateHomebrewInstallerURL(installerURL); err != nil {
		return fail(err)
	}

	// Already installed: report and touch nothing. Checked before the console
	// user so a machine that already has brew never fails on an unattended
	// (loginwindow) console.
	if path, err := deps.brewPath(); err == nil {
		return NewSuccessResult(map[string]any{
			"action":           "homebrew_bootstrap",
			"success":          true,
			"alreadyInstalled": true,
			"brewPath":         path,
		}, time.Since(startTime).Milliseconds())
	}

	account, err := deps.consoleUser()
	if err != nil {
		return fail(fmt.Errorf("homebrew bootstrap requires a signed-in admin console session: %w", err))
	}

	body, err := deps.download(installerURL)
	if err != nil {
		// %s, never %w: net/http wraps transport failures in *url.Error whose
		// message repeats the request URL.
		return fail(fmt.Errorf("installer download failed: %s", safeDownloadError(err)))
	}

	actual := computeSHA256Bytes(body)
	if !strings.EqualFold(actual, installerSha) {
		return fail(fmt.Errorf("installer checksum mismatch: expected %s, got %s", installerSha, actual))
	}

	// Only now — after the bytes are proven to be the pinned installer — does
	// anything touch the filesystem or a shell.
	tempDir, err := os.MkdirTemp(bootstrapTempBaseDir, "breeze-brew-bootstrap-*")
	if err != nil {
		return fail(fmt.Errorf("failed to create temp dir: %w", err))
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	scriptPath := filepath.Join(tempDir, "install.sh")
	if err := os.WriteFile(scriptPath, body, 0o600); err != nil {
		return fail(fmt.Errorf("failed to write installer: %w", err))
	}
	// The script is executed as the console user, so it has to be readable by
	// that user: widen the root-owned dir + file to read-only-for-others AFTER
	// the verified content is in place. Nothing is ever group/world writable,
	// so the verified bytes cannot be swapped underneath the shell.
	if err := os.Chmod(tempDir, 0o755); err != nil {
		return fail(fmt.Errorf("failed to prepare installer dir: %w", err))
	}
	if err := os.Chmod(scriptPath, 0o644); err != nil {
		return fail(fmt.Errorf("failed to prepare installer: %w", err))
	}

	output, exitCode, runErr := deps.runScript(scriptPath, account)
	output, truncated := sanitizeInstallerOutput(output)
	if runErr != nil {
		errMsg := fmt.Sprintf("homebrew installer failed: %v", runErr)
		if truncated {
			errMsg += " (installer output truncated)"
		}
		return CommandResult{
			Status:     "failed",
			ExitCode:   exitCode,
			Stdout:     output,
			Error:      errMsg,
			DurationMs: time.Since(startTime).Milliseconds(),
		}
	}

	// The installer's exit code alone is not trusted — verify brew is really
	// on disk before reporting success (mirrors the software_install detection
	// contract).
	resolved, err := deps.brewPath()
	if err != nil {
		return CommandResult{
			Status:     "failed",
			ExitCode:   1,
			Stdout:     output,
			Error:      fmt.Sprintf("installer reported success but %v", err),
			DurationMs: time.Since(startTime).Milliseconds(),
		}
	}

	success := map[string]any{
		"action":           "homebrew_bootstrap",
		"success":          true,
		"alreadyInstalled": false,
		"brewPath":         resolved,
		"consoleUser":      account.Username,
		"exitCode":         exitCode,
		"output":           output,
	}
	if truncated {
		success["outputTruncated"] = true
	}
	return NewSuccessResult(success, time.Since(startTime).Milliseconds())
}

// validateHomebrewInstallerURL enforces that the agent will only ever fetch
// the official Homebrew installer at an IMMUTABLE ref. A moving ref
// (HEAD/master/main) can change under the pinned sha256 the server sent, which
// would turn every bootstrap into a checksum failure at best — and defeats the
// point of pinning at worst.
func validateHomebrewInstallerURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("installerUrl is not a valid URL")
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("installerUrl must be https")
	}
	if parsed.Host != homebrewInstallerHost {
		return fmt.Errorf("installerUrl host must be %s", homebrewInstallerHost)
	}
	if !strings.HasPrefix(parsed.Path, homebrewInstallerPathRoot) {
		return fmt.Errorf("installerUrl must point at the Homebrew/install repository")
	}
	rest := strings.TrimPrefix(parsed.Path, homebrewInstallerPathRoot)
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[1] != "install.sh" {
		return fmt.Errorf("installerUrl must be <ref>/install.sh")
	}
	ref := parts[0]
	switch strings.ToLower(ref) {
	case "", "head", "master", "main":
		return fmt.Errorf("installerUrl must pin an immutable ref, not %q", ref)
	}
	return nil
}

func computeSHA256Bytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func downloadHomebrewInstaller(rawURL string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), homebrewInstallerDownloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{
		Timeout: homebrewInstallerDownloadTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			// The pinned raw.githubusercontent.com URL is served directly; a
			// redirect would be somewhere we did not validate.
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxHomebrewInstallerBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxHomebrewInstallerBytes {
		return nil, fmt.Errorf("installer exceeds %d bytes", maxHomebrewInstallerBytes)
	}
	return body, nil
}

// runHomebrewInstaller executes the verified script as the console user.
// Homebrew refuses to run as root, so an elevated agent re-runs it through
// sudo -u <console user> — the same construction brewCommand uses for every
// other brew invocation. NONINTERACTIVE=1 keeps the installer from blocking on
// a "press RETURN" prompt no one is watching.
func runHomebrewInstaller(scriptPath string, account *user.User) (string, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), homebrewBootstrapTimeout)
	defer cancel()

	var cmd *exec.Cmd
	if os.Geteuid() == 0 {
		// NONINTERACTIVE is set via /usr/bin/env rather than as a sudo
		// command-line assignment: the latter needs SETENV in sudoers and
		// would fail closed on a hardened Mac, leaving the installer waiting
		// on a RETURN prompt nobody is watching until the 20-minute timeout.
		cmd = exec.CommandContext(ctx, "/usr/bin/sudo", "-n", "-H", "-u", account.Username,
			"/usr/bin/env", "NONINTERACTIVE=1", "/bin/bash", scriptPath)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/bash", scriptPath)
	}
	env := append(os.Environ(), "NONINTERACTIVE=1")
	if account.HomeDir != "" {
		env = append(env, "HOME="+account.HomeDir)
	}
	cmd.Env = env

	out, err := cmd.CombinedOutput()
	exitCode := 0
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return string(out), -1, fmt.Errorf("timed out after %s", homebrewBootstrapTimeout)
		}
		exitCode = 1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}
	return string(out), exitCode, err
}
