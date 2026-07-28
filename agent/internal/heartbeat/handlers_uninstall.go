package heartbeat

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdSelfUninstall] = handleSelfUninstall
}

// uninstallHelperDelaySeconds is how long the detached teardown helper sleeps
// before stopping the agent's own service. It must be long enough for the
// command result (submitted right after this handler returns) to reach the API
// and for the agent to stop accepting new commands, but short enough that a
// reboot or watchdog reinstall racing the teardown is unlikely.
const uninstallHelperDelaySeconds = 5

// handleSelfUninstall uninstalls the agent from the machine.
//
// The teardown is split into two phases (#2878):
//
//   - Phase 1 runs in-process BEFORE the result is acked: neutralize the
//     watchdog (so it cannot respawn the agent mid-teardown), remove every
//     artifact that is safe to remove while the agent is still running, and
//     hand the self-referential steps — stopping/deleting the agent's OWN
//     service and removing its own binary — to a detached helper process that
//     survives this process's death.
//
//   - Phase 2 is the detached helper, which runs the self-referential steps
//     after a short delay, by which point the result has been submitted.
//
// The previous implementation ran the whole sequence in-process and stopped
// the agent's own service FIRST — on Windows `sc.exe stop BreezeAgent` killed
// this very process before `sc.exe delete`, the watchdog teardown, or config
// removal ever ran, leaving the machine fully installed (watchdog running,
// auto-start service, severed token → permanent 401 hammering, the #2796
// stranded-traffic scenario) while the offboarding drain recorded a clean
// uninstall. macOS (`launchctl bootout` of its own daemon first) and Linux
// (`systemctl stop` of its own unit first) had the same self-kill-first bug.
//
// If phase 1 cannot hand the teardown off, the machine is NOT going to
// uninstall itself, so the command reports failure — the offboarding drain
// must not count this device as cleanly uninstalled.
func handleSelfUninstall(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	removeConfig := tools.GetPayloadBool(cmd.Payload, "removeConfig", true)

	log.Warn("self_uninstall command received — uninstalling agent",
		"removeConfig", removeConfig,
	)

	if err := prepareSelfUninstall(removeConfig); err != nil {
		log.Error("self-uninstall preparation failed — teardown NOT handed off, agent remains installed",
			"error", err.Error(),
		)
		return tools.NewErrorResult(
			fmt.Errorf("self-uninstall failed before teardown handoff (agent remains installed): %w", err),
			time.Since(start).Milliseconds(),
		)
	}

	// Shut down gracefully once the result has had time to be submitted. The
	// detached helper stops the service as its first act, so on a normal
	// service install the process exits via the service manager's stop control;
	// the explicit Stop/os.Exit below is a backstop for non-service (dev) runs.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic during self-uninstall shutdown", "panic", fmt.Sprint(r))
			}
		}()

		// Brief delay so the command result can be submitted.
		time.Sleep(2 * time.Second)
		h.StopAcceptingCommands()

		// Give the detached helper time to stop the service (the normal exit
		// path). If we are still alive well past its delay — e.g. not running
		// under a service manager — stop and exit ourselves.
		time.Sleep(time.Duration(uninstallHelperDelaySeconds+10) * time.Second)
		h.Stop()
		time.Sleep(5 * time.Second)
		os.Exit(0)
	}()

	return tools.NewSuccessResult(map[string]string{
		"message": "self-uninstall initiated: watchdog neutralized, detached teardown handed off",
	}, time.Since(start).Milliseconds())
}

// prepareSelfUninstall does the platform-specific phase-1 teardown and hands
// the self-referential steps to a detached helper. It returns an error only
// when the handoff itself fails; individual best-effort cleanup failures are
// logged but do not abort the uninstall.
func prepareSelfUninstall(removeConfig bool) error {
	switch runtime.GOOS {
	case "darwin":
		return prepareSelfUninstallDarwin(removeConfig)
	case "linux":
		return prepareSelfUninstallLinux(removeConfig)
	case "windows":
		return prepareSelfUninstallWindows(removeConfig)
	default:
		return fmt.Errorf("unsupported OS for self-uninstall: %s", runtime.GOOS)
	}
}

// removeFileLogged removes path, logging (but not failing on) errors other
// than the file already being absent.
func removeFileLogged(path string) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		log.Warn("self-uninstall: failed to remove file", "path", path, "error", err.Error())
	}
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

// darwinUninstallScriptOptions captures the inputs to the detached shell
// script that removes the agent's own launchd daemon on macOS. Extracted so
// the script text can be unit-tested without spawning a shell.
type darwinUninstallScriptOptions struct {
	Label        string // launchd label of the agent daemon (bootout kills this process)
	PlistPath    string // the agent daemon's plist
	BinaryPath   string // the agent binary
	DelaySeconds int
}

// buildDarwinUninstallScript renders the detached teardown script for macOS.
// Everything except the agent's own daemon was already removed in-process by
// prepareSelfUninstallDarwin; this script only performs the steps that would
// kill the process issuing them.
func buildDarwinUninstallScript(opts darwinUninstallScriptOptions) string {
	lines := []string{
		fmt.Sprintf("sleep %d", opts.DelaySeconds),
		fmt.Sprintf("launchctl bootout system/%s || launchctl unload %s", shQuote(opts.Label), shQuote(opts.PlistPath)),
		fmt.Sprintf("rm -f %s", shQuote(opts.PlistPath)),
		fmt.Sprintf("rm -f %s", shQuote(opts.BinaryPath)),
	}
	return strings.Join(lines, "\n")
}

// prepareSelfUninstallDarwin removes the watchdog, user helper, plists, the
// watchdog binary, and (optionally) config in-process, then hands the removal
// of the agent's own daemon + binary to a detached shell.
func prepareSelfUninstallDarwin(removeConfig bool) error {
	const (
		label            = "com.breeze.agent"
		userLabel        = "com.breeze.agent-user"
		watchdogLabel    = "com.breeze.watchdog"
		plistDst         = "/Library/LaunchDaemons/com.breeze.agent.plist"
		userPlistDst     = "/Library/LaunchAgents/com.breeze.agent-user.plist"
		watchdogPlistDst = "/Library/LaunchDaemons/com.breeze.watchdog.plist"
		binaryPath       = "/usr/local/bin/breeze-agent"
		watchdogBinary   = "/usr/local/bin/breeze-watchdog"
		configDir        = "/Library/Application Support/Breeze"
	)

	// Watchdog FIRST — it must be gone before anything stops the agent, or it
	// may respawn/reinstall the agent mid-teardown.
	if err := exec.Command("launchctl", "bootout", "system/"+watchdogLabel).Run(); err != nil {
		log.Warn("launchctl bootout watchdog failed, trying legacy unload", "error", err.Error())
		_ = exec.Command("launchctl", "unload", watchdogPlistDst).Run()
	}
	if err := exec.Command("launchctl", "bootout", "system/"+userLabel).Run(); err != nil {
		_ = exec.Command("launchctl", "unload", userPlistDst).Run()
	}

	removeFileLogged(watchdogPlistDst)
	removeFileLogged(userPlistDst)
	removeFileLogged(watchdogBinary)

	if removeConfig {
		if err := os.RemoveAll(configDir); err != nil {
			log.Warn("self-uninstall: failed to remove config dir", "path", configDir, "error", err.Error())
		}
	}

	// Booting out our own daemon kills this process, so it (and the removal of
	// our own plist/binary) runs from a detached session after we exit.
	script := buildDarwinUninstallScript(darwinUninstallScriptOptions{
		Label:        label,
		PlistPath:    plistDst,
		BinaryPath:   binaryPath,
		DelaySeconds: uninstallHelperDelaySeconds,
	})
	if err := startDetachedProcess("/bin/sh", "-c", script); err != nil {
		return fmt.Errorf("spawn detached teardown helper: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

// linuxUninstallScriptOptions captures the inputs to the detached shell script
// that removes the agent's own systemd unit on Linux.
type linuxUninstallScriptOptions struct {
	ServiceName  string // the agent's own unit (stopping it kills this process)
	UnitPath     string
	BinaryPath   string
	DelaySeconds int
}

// buildLinuxUninstallScript renders the detached teardown script for Linux.
func buildLinuxUninstallScript(opts linuxUninstallScriptOptions) string {
	lines := []string{
		fmt.Sprintf("sleep %d", opts.DelaySeconds),
		fmt.Sprintf("systemctl stop %s", shQuote(opts.ServiceName)),
		fmt.Sprintf("rm -f %s", shQuote(opts.UnitPath)),
		"systemctl daemon-reload",
		fmt.Sprintf("rm -f %s", shQuote(opts.BinaryPath)),
	}
	return strings.Join(lines, "\n")
}

// prepareSelfUninstallLinux removes the watchdog, unit files, the watchdog
// binary, and (optionally) config in-process, then hands the stop + removal of
// the agent's own unit + binary to a detached shell.
func prepareSelfUninstallLinux(removeConfig bool) error {
	const (
		serviceName     = "breeze-agent"
		watchdogService = "breeze-watchdog"
		unitDst         = "/etc/systemd/system/breeze-agent.service"
		watchdogUnitDst = "/etc/systemd/system/breeze-watchdog.service"
		userUnitDst     = "/usr/lib/systemd/user/breeze-agent-user.service"
		binaryPath      = "/usr/local/bin/breeze-agent"
		watchdogBinary  = "/usr/local/bin/breeze-watchdog"
		configDir       = "/etc/breeze"
	)

	// Watchdog FIRST (see prepareSelfUninstallDarwin).
	if err := exec.Command("systemctl", "stop", watchdogService).Run(); err != nil {
		log.Warn("systemctl stop watchdog failed", "error", err.Error())
	}
	if err := exec.Command("systemctl", "disable", watchdogService).Run(); err != nil {
		log.Warn("systemctl disable watchdog failed", "error", err.Error())
	}
	// Disabling (not stopping!) our own service is safe while running and
	// prevents an auto-start if the host reboots mid-teardown.
	if err := exec.Command("systemctl", "disable", serviceName).Run(); err != nil {
		log.Warn("systemctl disable agent failed", "error", err.Error())
	}

	removeFileLogged(watchdogUnitDst)
	removeFileLogged(userUnitDst)
	removeFileLogged(watchdogBinary)

	if removeConfig {
		if err := os.RemoveAll(configDir); err != nil {
			log.Warn("self-uninstall: failed to remove config dir", "path", configDir, "error", err.Error())
		}
	}

	// Stopping our own unit kills this process (systemd SIGTERMs the cgroup),
	// so it runs from a detached session after we exit. The agent's own unit
	// file must survive until then so the stop is clean.
	script := buildLinuxUninstallScript(linuxUninstallScriptOptions{
		ServiceName:  serviceName,
		UnitPath:     unitDst,
		BinaryPath:   binaryPath,
		DelaySeconds: uninstallHelperDelaySeconds,
	})
	if err := startDetachedProcess("/bin/sh", "-c", script); err != nil {
		return fmt.Errorf("spawn detached teardown helper: %w", err)
	}
	return nil
}

// shQuote single-quotes s for POSIX sh, escaping embedded single quotes.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// windowsUninstallScriptOptions captures the inputs to the detached PowerShell
// helper that tears down the agent's own service on Windows. Extracted (like
// updater.buildRestartScript) so the script text can be unit-tested without
// spawning PowerShell.
type windowsUninstallScriptOptions struct {
	ServiceName         string
	WatchdogServiceName string
	AgentBinaryPath     string
	WatchdogBinaryPath  string
	ConfigDir           string // empty = skip config removal regardless of RemoveConfig
	RemoveConfig        bool
	DelaySeconds        int
}

// buildWindowsUninstallScript renders the detached PowerShell teardown script.
// Ordering is load-bearing:
//
//  1. Stop-Service on the agent (waits for Stopped — this is what kills the
//     agent process, AFTER the command result has been submitted),
//  2. delete both service registrations,
//  3. kill lingering sibling helper processes that could hold file locks,
//  4. remove the binaries (unlocked once the processes are gone),
//  5. remove config last (the agent's open log handles are released by then),
//  6. the script deletes itself.
//
// Removal steps use -ErrorAction SilentlyContinue: by this point the process
// that could report errors is gone, so best-effort is all there is.
func buildWindowsUninstallScript(opts windowsUninstallScriptOptions) string {
	lines := []string{
		fmt.Sprintf("Start-Sleep -Seconds %d", opts.DelaySeconds),
		fmt.Sprintf("Stop-Service -Name '%s' -Force -ErrorAction SilentlyContinue", psQuote(opts.ServiceName)),
		fmt.Sprintf("sc.exe delete '%s' | Out-Null", psQuote(opts.ServiceName)),
		// Re-assert the watchdog teardown: phase 1 already stopped/deleted it,
		// but sc.exe stop is asynchronous — if it was still STOP_PENDING when
		// phase 1's delete ran, the delete may not have taken.
		fmt.Sprintf("sc.exe stop '%s' | Out-Null", psQuote(opts.WatchdogServiceName)),
		fmt.Sprintf("sc.exe delete '%s' | Out-Null", psQuote(opts.WatchdogServiceName)),
		"Get-Process -Name 'breeze-user-helper','breeze-desktop-helper','breeze-watchdog' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
		"Start-Sleep -Seconds 1",
		fmt.Sprintf("Remove-Item -Path '%s' -Force -ErrorAction SilentlyContinue", psQuote(opts.WatchdogBinaryPath)),
		fmt.Sprintf("Remove-Item -Path '%s' -Force -ErrorAction SilentlyContinue", psQuote(opts.AgentBinaryPath)),
	}
	if opts.RemoveConfig && opts.ConfigDir != "" {
		lines = append(lines,
			fmt.Sprintf("Remove-Item -Path '%s' -Recurse -Force -ErrorAction SilentlyContinue", psQuote(opts.ConfigDir)),
		)
	}
	lines = append(lines, "Remove-Item -Path $PSCommandPath -Force -ErrorAction SilentlyContinue")
	return strings.Join(lines, "\r\n")
}

// psQuote escapes s for inclusion inside a single-quoted PowerShell string.
func psQuote(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// prepareSelfUninstallWindows neutralizes the watchdog in-process, then hands
// the full self-referential teardown (stop + delete own service, binary and
// config removal) to a detached PowerShell helper.
//
// The agent binary, the watchdog binary, and the config dir (which holds the
// agent's open log files) are all locked while their processes run, so ALL
// file removal happens in the detached helper after the processes are gone —
// unlike the Unix paths, where in-process removal of non-self files is safe.
func prepareSelfUninstallWindows(removeConfig bool) error {
	const (
		serviceName         = "BreezeAgent"
		watchdogServiceName = "BreezeWatchdog"
	)

	// Watchdog FIRST — it must be unable to respawn the agent once the helper
	// stops the agent service. sc.exe delete on a STOP_PENDING service marks it
	// delete-pending, which completes when it stops; the helper re-asserts both
	// steps anyway.
	if err := exec.Command("sc.exe", "stop", watchdogServiceName).Run(); err != nil {
		log.Warn("sc.exe stop watchdog failed", "error", err.Error())
	}
	if err := exec.Command("sc.exe", "delete", watchdogServiceName).Run(); err != nil {
		log.Warn("sc.exe delete watchdog failed", "error", err.Error())
	}

	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve own executable path: %w", err)
	}

	configDir := ""
	if programData := os.Getenv("ProgramData"); programData != "" {
		configDir = filepath.Join(programData, "Breeze")
	}

	script := buildWindowsUninstallScript(windowsUninstallScriptOptions{
		ServiceName:         serviceName,
		WatchdogServiceName: watchdogServiceName,
		AgentBinaryPath:     exePath,
		// The watchdog is installed as a sibling of the agent binary (see
		// serviceinstall.InstallProtectedBinary / sessionbroker allowlist).
		WatchdogBinaryPath: filepath.Join(filepath.Dir(exePath), "breeze-watchdog.exe"),
		ConfigDir:          configDir,
		RemoveConfig:       removeConfig,
		DelaySeconds:       uninstallHelperDelaySeconds,
	})

	scriptFile, err := os.CreateTemp("", "breeze-uninstall-*.ps1")
	if err != nil {
		return fmt.Errorf("create uninstall helper script: %w", err)
	}
	if _, err := scriptFile.WriteString(script); err != nil {
		scriptFile.Close()
		os.Remove(scriptFile.Name())
		return fmt.Errorf("write uninstall helper script: %w", err)
	}
	if err := scriptFile.Close(); err != nil {
		os.Remove(scriptFile.Name())
		return fmt.Errorf("close uninstall helper script: %w", err)
	}

	if err := startDetachedProcess("powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", scriptFile.Name(),
	); err != nil {
		os.Remove(scriptFile.Name())
		return fmt.Errorf("spawn detached teardown helper: %w", err)
	}
	return nil
}
