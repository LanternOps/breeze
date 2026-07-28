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

	if err := prepareSelfUninstallFn(removeConfig); err != nil {
		log.Error("self-uninstall preparation failed — teardown NOT handed off, agent service remains installed",
			"error", err.Error(),
		)
		return tools.NewErrorResult(
			fmt.Errorf("self-uninstall failed before teardown handoff — agent service remains installed and auto-start; watchdog/helper artifacts may already be partially removed, retry required: %w", err),
			time.Since(start).Milliseconds(),
		)
	}

	scheduleSelfUninstallShutdownFn(h)

	return tools.NewSuccessResult(map[string]string{
		"message": "self-uninstall initiated: detached teardown handed off",
	}, time.Since(start).Milliseconds())
}

// prepareSelfUninstallFn and scheduleSelfUninstallShutdownFn are seams so the
// handler's result contract (error result when the handoff fails, success
// result otherwise, no shutdown scheduled on failure) is unit-testable without
// touching a real service manager or exiting the test process.
var (
	prepareSelfUninstallFn          = prepareSelfUninstall
	scheduleSelfUninstallShutdownFn = scheduleSelfUninstallShutdown
)

// scheduleSelfUninstallShutdown shuts the agent down gracefully once the
// result has had time to be submitted. The detached helper stops the service
// after its delay, so on a normal service install the process exits via the
// service manager's stop control; the explicit Stop/os.Exit below is a
// backstop for non-service (dev) runs and blocked helpers.
func scheduleSelfUninstallShutdown(h *Heartbeat) {
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
		// under a service manager, or the helper was blocked (EDR/AV killing a
		// service-spawned PowerShell is realistic on managed endpoints) — log
		// loudly and stop ourselves. The log line is the only in-band evidence
		// that the handed-off teardown may not have run.
		time.Sleep(time.Duration(uninstallHelperDelaySeconds+10) * time.Second)
		log.Warn("agent still running after detached teardown helper's deadline — helper may have been blocked; stopping self (service registration may survive)",
			"helperDelaySeconds", uninstallHelperDelaySeconds,
		)
		h.Stop()
		time.Sleep(5 * time.Second)
		os.Exit(0)
	}()
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
	Label           string // launchd label of the agent daemon (bootout kills this process)
	WatchdogLabel   string // launchd label of the watchdog daemon
	WatchdogProcess string // watchdog process name for the pkill re-assert
	PlistPath       string // the agent daemon's plist
	BinaryPath      string // the agent binary
	ConfigDir       string // empty = skip config removal regardless of RemoveConfig
	RemoveConfig    bool
	DelaySeconds    int
}

// buildDarwinUninstallScript renders the detached teardown script for macOS.
// Phase 1 already neutralized the watchdog in-process; the script re-asserts
// it (bootout + pkill) BEFORE stopping the agent daemon as a backstop, so a
// watchdog that survived phase 1 cannot respawn the agent mid-teardown.
// Config removal happens here — after the agent process is dead — so the
// still-running agent cannot resurrect files (logs, sockets, state) under a
// freshly-deleted directory.
func buildDarwinUninstallScript(opts darwinUninstallScriptOptions) string {
	lines := []string{
		fmt.Sprintf("sleep %d", opts.DelaySeconds),
		fmt.Sprintf("launchctl bootout system/%s", shQuote(opts.WatchdogLabel)),
		fmt.Sprintf("pkill -x %s", shQuote(opts.WatchdogProcess)),
		fmt.Sprintf("launchctl bootout system/%s || launchctl unload %s", shQuote(opts.Label), shQuote(opts.PlistPath)),
		fmt.Sprintf("rm -f %s", shQuote(opts.PlistPath)),
		fmt.Sprintf("rm -f %s", shQuote(opts.BinaryPath)),
	}
	if opts.RemoveConfig && opts.ConfigDir != "" {
		lines = append(lines, fmt.Sprintf("rm -rf %s", shQuote(opts.ConfigDir)))
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

	// Disable our own daemon (safe while running) so that if the detached
	// helper never runs — blocked, reboot inside the window — the host comes
	// back with the agent NOT auto-starting into permanent 401s (#2796).
	if err := exec.Command("launchctl", "disable", "system/"+label).Run(); err != nil {
		log.Warn("launchctl disable agent failed", "error", err.Error())
	}

	removeFileLogged(watchdogPlistDst)
	removeFileLogged(userPlistDst)
	removeFileLogged(watchdogBinary)

	// Booting out our own daemon kills this process, so it (plus the removal
	// of our own plist/binary and the config dir — which holds live logs,
	// sockets, and state files this process would otherwise resurrect) runs
	// from a detached session after we exit.
	script := buildDarwinUninstallScript(darwinUninstallScriptOptions{
		Label:           label,
		WatchdogLabel:   watchdogLabel,
		WatchdogProcess: "breeze-watchdog",
		PlistPath:       plistDst,
		BinaryPath:      binaryPath,
		ConfigDir:       configDir,
		RemoveConfig:    removeConfig,
		DelaySeconds:    uninstallHelperDelaySeconds,
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
	ServiceName     string // the agent's own unit (stopping it kills this process)
	WatchdogService string
	WatchdogProcess string // watchdog process name for the pkill re-assert
	UnitPath        string
	BinaryPath      string
	ConfigDir       string // empty = skip config removal regardless of RemoveConfig
	RemoveConfig    bool
	DelaySeconds    int
}

// buildLinuxUninstallScript renders the detached teardown script for Linux.
// The watchdog re-assert (stop + pkill) comes BEFORE the agent stop so a
// watchdog that survived phase 1 cannot respawn the agent mid-teardown, and
// config removal comes after the agent is dead (see the darwin builder).
func buildLinuxUninstallScript(opts linuxUninstallScriptOptions) string {
	lines := []string{
		fmt.Sprintf("sleep %d", opts.DelaySeconds),
		fmt.Sprintf("systemctl stop %s", shQuote(opts.WatchdogService)),
		fmt.Sprintf("pkill -x %s", shQuote(opts.WatchdogProcess)),
		fmt.Sprintf("systemctl stop %s", shQuote(opts.ServiceName)),
		fmt.Sprintf("rm -f %s", shQuote(opts.UnitPath)),
		"systemctl daemon-reload",
		fmt.Sprintf("rm -f %s", shQuote(opts.BinaryPath)),
	}
	if opts.RemoveConfig && opts.ConfigDir != "" {
		lines = append(lines, fmt.Sprintf("rm -rf %s", shQuote(opts.ConfigDir)))
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

	// Stopping our own unit kills this process, so it (plus unit/binary/config
	// removal) runs from a detached helper after we exit.
	//
	// CRITICAL: Setsid alone is NOT enough on Linux. A Setsid'd child still
	// lives in the breeze-agent.service CGROUP, and the unit runs
	// KillMode=mixed — when `systemctl stop breeze-agent` runs, systemd
	// SIGTERMs the main process and then SIGKILLs every remaining process in
	// the cgroup at TimeoutStopSec (see internal/agentapp/systemd_unit.go), so
	// a plain /bin/sh helper would die mid-script right after issuing the stop
	// — recreating the #2878 false success on Linux. `systemd-run` registers
	// the helper as a transient unit in its OWN cgroup, outside the kill
	// radius — the same escape used by tools.spawnDelayedRestart
	// (internal/remote/tools/agent_restart_linux.go). --collect garbage-
	// collects the transient unit even if the script fails.
	script := buildLinuxUninstallScript(linuxUninstallScriptOptions{
		ServiceName:     serviceName,
		WatchdogService: watchdogService,
		WatchdogProcess: "breeze-watchdog",
		UnitPath:        unitDst,
		BinaryPath:      binaryPath,
		ConfigDir:       configDir,
		RemoveConfig:    removeConfig,
		DelaySeconds:    uninstallHelperDelaySeconds,
	})
	if err := startDetachedProcess("systemd-run", "--quiet", "--collect", "--", "/bin/sh", "-c", script); err != nil {
		return fmt.Errorf("spawn detached teardown helper (systemd-run transient unit): %w", err)
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
//  1. re-assert the watchdog teardown FIRST (phase 1 already stopped/deleted
//     it, but sc.exe stop is asynchronous — a watchdog that survived phase 1
//     must be dead before the agent stops or it may respawn it),
//  2. Stop-Service on the agent (waits for Stopped — this is what kills the
//     agent process, AFTER the command result has been submitted),
//  3. delete both service registrations,
//  4. kill lingering sibling processes that could hold file locks (including
//     any watchdog-respawned agent),
//  5. remove the binaries (unlocked once the processes are gone),
//  6. remove config last (the agent's open log handles are released by then),
//  7. the script deletes itself.
//
// Removal steps use -LiteralPath (never -Path: `[`/`]` in an install path
// would be glob-expanded into a silent no-op) and -ErrorAction
// SilentlyContinue: by this point the process that could report errors is
// gone, so best-effort is all there is.
func buildWindowsUninstallScript(opts windowsUninstallScriptOptions) string {
	lines := []string{
		fmt.Sprintf("Start-Sleep -Seconds %d", opts.DelaySeconds),
		fmt.Sprintf("sc.exe stop '%s' | Out-Null", psQuote(opts.WatchdogServiceName)),
		fmt.Sprintf("sc.exe delete '%s' | Out-Null", psQuote(opts.WatchdogServiceName)),
		fmt.Sprintf("Stop-Service -Name '%s' -Force -ErrorAction SilentlyContinue", psQuote(opts.ServiceName)),
		fmt.Sprintf("sc.exe delete '%s' | Out-Null", psQuote(opts.ServiceName)),
		"Get-Process -Name 'breeze-agent','breeze-user-helper','breeze-desktop-helper','breeze-watchdog' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
		"Start-Sleep -Seconds 1",
		fmt.Sprintf("Remove-Item -LiteralPath '%s' -Force -ErrorAction SilentlyContinue", psQuote(opts.WatchdogBinaryPath)),
		fmt.Sprintf("Remove-Item -LiteralPath '%s' -Force -ErrorAction SilentlyContinue", psQuote(opts.AgentBinaryPath)),
	}
	if opts.RemoveConfig && opts.ConfigDir != "" {
		lines = append(lines,
			fmt.Sprintf("Remove-Item -LiteralPath '%s' -Recurse -Force -ErrorAction SilentlyContinue", psQuote(opts.ConfigDir)),
		)
	}
	lines = append(lines, "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue")
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

	// Disable our own service's auto-start and clear its SCM recovery actions
	// (both safe while running) so that if the detached helper never runs —
	// EDR blocking a service-spawned PowerShell, a temp cleaner, a reboot
	// inside the window — the backstop os.Exit doesn't get treated as a crash
	// and restarted, and the host doesn't reboot back into permanent 401
	// hammering (#2796). Worst case degrades to "stopped + disabled, binary
	// on disk" instead of "alive and stranded".
	if err := exec.Command("sc.exe", "config", serviceName, "start=", "disabled").Run(); err != nil {
		log.Warn("sc.exe config start=disabled failed", "error", err.Error())
	}
	if err := exec.Command("sc.exe", "failure", serviceName, "reset=", "0", "actions=", "").Run(); err != nil {
		log.Warn("sc.exe failure reset failed", "error", err.Error())
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
		_ = scriptFile.Close()
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("write uninstall helper script: %w", err)
	}
	if err := scriptFile.Close(); err != nil {
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("close uninstall helper script: %w", err)
	}

	if err := startDetachedProcess("powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", scriptFile.Name(),
	); err != nil {
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("spawn detached teardown helper: %w", err)
	}
	return nil
}
