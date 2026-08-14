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

// RunLocalUninstall is the entry point for the AUTHORIZED LOCAL uninstall
// (`nu-agent uninstall --token …`, cmd/nu-agent/uninstall.go).
//
// It deliberately does NOT implement any teardown of its own: it calls the
// exact same prepareSelfUninstall the RMM-pushed self_uninstall command uses,
// so there is one teardown path, one watchdog-neutralisation ordering, and one
// detached helper. The ONLY difference between remote and local uninstall is
// who authorized it — the command channel in one case, a server-verified
// single-use token in the other. The caller is responsible for having obtained
// that authorization BEFORE calling this; nothing here re-checks it.
//
// The caller (a short-lived CLI process, not the service) stays alive after
// this returns and runs VerifyTeardown once the detached helper has had time
// to finish, which is what turns "we asked for removal" into "removal is
// proven".
func RunLocalUninstall(removeConfig bool) error {
	log.Warn("authorized local uninstall starting", "removeConfig", removeConfig)
	if err := prepareSelfUninstallFn(removeConfig); err != nil {
		return fmt.Errorf("local uninstall failed before teardown handoff — agent remains installed: %w", err)
	}
	return nil
}

// UninstallHelperDelaySeconds exposes the detached helper's delay so the local
// CLI knows how long to wait before its verification sweep.
const UninstallHelperDelaySeconds = uninstallHelperDelaySeconds

// removeFileLogged removes path, logging (but not failing on) errors other
// than the file already being absent.
func removeFileLogged(path string) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		log.Warn("self-uninstall: failed to remove file", "path", path, "error", err.Error())
	}
}

// ---------------------------------------------------------------------------
// macOS — full teardown derived from the .pkg payload manifests
// ---------------------------------------------------------------------------

// nuPkgIDPrefix is the identifier namespace every Nodes Unlimited installer
// package uses (installer/macos/build-pkg.sh IDENTIFIER, and any sibling pkg
// a future component ships). Matching on the PREFIX — not on a hardcoded list
// of ids — is what makes a newly added payload uninstall itself without a
// change here.
const nuPkgIDPrefix = "com.nodesunlimited."

// DarwinUninstallLogPath is where an INCOMPLETE teardown is recorded. It is
// deliberately outside every directory the uninstall removes, so the evidence
// of failure cannot be deleted by the failing run itself.
const DarwinUninstallLogPath = "/var/log/nu-agent-uninstall.log"

// payloadRootAllowlist bounds where a payload path may be removed from.
//
// `pkgutil --files` reports paths RELATIVE to `/`, including the ancestor
// directories of every file. Removing those verbatim would mean `rm -rf
// /usr/local/bin` — deleting unrelated software — so the derived list is
// filtered twice: `--only-files` at the pkgutil call, and this allowlist,
// which also rejects the ancestors themselves (an entry must be strictly
// BELOW a root, never equal to one).
var payloadRootAllowlist = []string{
	"/usr/local/bin/",
	"/Library/",
	"/Applications/",
}

// pkgutilFn is a seam so the manifest derivation is unit-testable without a
// real installer receipt database.
var pkgutilFn = func(args ...string) (string, error) {
	out, err := exec.Command("pkgutil", args...).Output()
	return string(out), err
}

// parsePkgIDs picks our package identifiers out of `pkgutil --pkgs` output.
func parsePkgIDs(out string) []string {
	var ids []string
	for _, line := range strings.Split(out, "\n") {
		id := strings.TrimSpace(line)
		if strings.HasPrefix(id, nuPkgIDPrefix) {
			ids = append(ids, id)
		}
	}
	return ids
}

// parsePayloadFiles converts one `pkgutil --files <id> --only-files` listing
// into absolute paths, dropping anything outside payloadRootAllowlist.
//
// This is the mechanism that keeps the uninstaller honest as the payload
// changes: whatever binaries the pkg laid down — nu-agent, nu-watchdog,
// nu-desktop-helper, nu-backup, and anything added later (a bundled remote-
// control helper, say) — come back from the receipt, so none of their names
// appear in this file.
func parsePayloadFiles(out string) []string {
	var paths []string
	for _, line := range strings.Split(out, "\n") {
		rel := strings.TrimSpace(line)
		if rel == "" {
			continue
		}
		abs := "/" + strings.TrimPrefix(rel, "/")
		abs = filepath.Clean(abs)
		if !underAllowedRoot(abs) {
			log.Warn("uninstall: ignoring payload path outside allowed roots", "path", abs)
			continue
		}
		paths = append(paths, abs)
	}
	return paths
}

// underAllowedRoot reports whether p sits strictly below one of the allowed
// roots. Equality with a root is rejected on purpose: `/usr/local/bin` itself
// is an ancestor directory, not a payload file.
func underAllowedRoot(p string) bool {
	for _, root := range payloadRootAllowlist {
		if strings.HasPrefix(p, root) && len(p) > len(root) {
			return true
		}
	}
	return false
}

// darwinPayloadArtifacts returns (package ids, payload file paths) for every
// installed Nodes Unlimited package. A pkgutil failure is logged and degrades
// to an empty payload list — the static artifact list below still runs, and
// the verification sweep still reports whatever survives.
func darwinPayloadArtifacts() (pkgIDs []string, paths []string) {
	listing, err := pkgutilFn("--pkgs")
	if err != nil {
		log.Warn("uninstall: pkgutil --pkgs failed; payload manifest unavailable", "error", err.Error())
		return nil, nil
	}
	pkgIDs = parsePkgIDs(listing)

	seen := map[string]bool{}
	for _, id := range pkgIDs {
		files, err := pkgutilFn("--files", id, "--only-files")
		if err != nil {
			log.Warn("uninstall: pkgutil --files failed", "pkg", id, "error", err.Error())
			continue
		}
		for _, p := range parsePayloadFiles(files) {
			if !seen[p] {
				seen[p] = true
				paths = append(paths, p)
			}
		}
	}
	return pkgIDs, paths
}

// darwinStaticArtifacts lists what the payload manifest CANNOT know about:
// files created by the install scripts or at runtime rather than shipped in
// the payload — launchd job definitions, the installer app, config/state/cache/
// log trees, and the agent's stored credentials.
func darwinStaticArtifacts() []string {
	return []string{
		"/Library/LaunchDaemons/com.nodesunlimited.agent.plist",
		"/Library/LaunchDaemons/com.nodesunlimited.watchdog.plist",
		"/Library/LaunchAgents/com.nodesunlimited.agent-user.plist",
		"/Library/LaunchAgents/com.nodesunlimited.desktop-helper-user.plist",
		"/Library/LaunchAgents/com.nodesunlimited.desktop-helper-loginwindow.plist",
		"/Applications/Nodes Unlimited Installer.app",
		// Config, state, logs and the enrollment secrets live under one root
		// (internal/config.configDir); the rest are runtime spillover.
		"/Library/Application Support/Nodes Unlimited",
		"/Library/Caches/com.nodesunlimited.agent",
		"/Library/Logs/Nodes Unlimited",
		"/var/db/receipts/com.nodesunlimited.agent.plist",
		"/var/db/receipts/com.nodesunlimited.agent.bom",
	}
}

// darwinLaunchdLabels are booted out (and, where present, removed) so no job
// stays registered with launchd after the files are gone.
func darwinLaunchdLabels() []string {
	return []string{
		"com.nodesunlimited.agent",
		"com.nodesunlimited.agent-user",
		"com.nodesunlimited.watchdog",
		"com.nodesunlimited.desktop-helper-user",
		"com.nodesunlimited.desktop-helper-loginwindow",
	}
}

// darwinKeychainServices are the generic-password services the agent may have
// stored credentials under. Deleting a non-existent item is a harmless no-op.
func darwinKeychainServices() []string {
	return []string{
		"com.nodesunlimited.agent",
		"Nodes Unlimited Agent",
	}
}

// DarwinTeardownPaths is the complete removal list: payload files derived from
// the installed package receipts, plus the static runtime artifacts. Exported
// so the local CLI can run the post-teardown verification sweep against the
// same list the script removed — one source of truth for "remove" and "prove
// it is gone".
func DarwinTeardownPaths() []string {
	_, payload := darwinPayloadArtifacts()
	return dedupePaths(append(payload, darwinStaticArtifacts()...))
}

func dedupePaths(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, p := range in {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}

// SurvivingArtifacts returns every path in the removal list that still exists.
// A non-empty result means the uninstall did NOT fully complete; the caller
// logs it loudly and exits non-zero.
func SurvivingArtifacts(paths []string) []string {
	var survivors []string
	for _, p := range paths {
		if _, err := os.Lstat(p); err == nil {
			survivors = append(survivors, p)
		}
	}
	return survivors
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

	// FULL-TEARDOWN inputs (local uninstall and remote alike). ExtraPaths is
	// derived from the .pkg payload manifests plus the static artifact list,
	// never hand-written per binary, so a payload addition is removed without
	// a code change here.
	ExtraPaths       []string
	PkgIDs           []string
	LaunchdLabels    []string
	KeychainServices []string
	// VerifyLogPath receives the loud failure record when something survives.
	// Empty disables the verification block (used by the legacy remote path's
	// unit tests, never in production).
	VerifyLogPath string
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

	// --- full teardown -----------------------------------------------------
	for _, label := range opts.LaunchdLabels {
		lines = append(lines,
			fmt.Sprintf("launchctl bootout system/%s 2>/dev/null || true", shQuote(label)),
			fmt.Sprintf("launchctl disable system/%s 2>/dev/null || true", shQuote(label)),
		)
	}
	for _, p := range opts.ExtraPaths {
		lines = append(lines, fmt.Sprintf("rm -rf %s", shQuote(p)))
	}
	for _, svc := range opts.KeychainServices {
		lines = append(lines,
			fmt.Sprintf("security delete-generic-password -s %s >/dev/null 2>&1 || true", shQuote(svc)))
	}
	// Receipts last: forgetting a package before its payload is removed would
	// lose the manifest the removal is derived from.
	for _, id := range opts.PkgIDs {
		lines = append(lines, fmt.Sprintf("pkgutil --forget %s >/dev/null 2>&1 || true", shQuote(id)))
	}

	// --- verification sweep ------------------------------------------------
	// Everything above is best-effort by necessity (the process doing the
	// removing is being removed). This block is what makes a partial uninstall
	// VISIBLE instead of silent: it re-checks every path, logs loudly to
	// syslog and to a log file, and exits non-zero.
	if opts.VerifyLogPath != "" {
		verify := []string{
			`survivors=""`,
		}
		for _, p := range append(append([]string{}, opts.ExtraPaths...), opts.BinaryPath, opts.PlistPath) {
			if p == "" {
				continue
			}
			verify = append(verify,
				fmt.Sprintf("if [ -e %s ]; then survivors=\"$survivors %s\"; fi", shQuote(p), p))
		}
		verify = append(verify,
			`if [ -n "$survivors" ]; then`,
			`  msg="nu-agent uninstall INCOMPLETE — surviving artifacts:$survivors"`,
			`  logger -t nu-agent-uninstall "$msg" 2>/dev/null || true`,
			fmt.Sprintf(`  echo "$msg" >> %s 2>/dev/null || true`, shQuote(opts.VerifyLogPath)),
			`  echo "$msg" >&2`,
			`  exit 1`,
			`fi`,
		)
		lines = append(lines, verify...)
	}

	return strings.Join(lines, "\n")
}

// prepareSelfUninstallDarwin removes the watchdog, user helper, plists, the
// watchdog binary, and (optionally) config in-process, then hands the removal
// of the agent's own daemon + binary to a detached shell.
func prepareSelfUninstallDarwin(removeConfig bool) error {
	const (
		label            = "com.nodesunlimited.agent"
		userLabel        = "com.nodesunlimited.agent-user"
		watchdogLabel    = "com.nodesunlimited.watchdog"
		plistDst         = "/Library/LaunchDaemons/com.nodesunlimited.agent.plist"
		userPlistDst     = "/Library/LaunchAgents/com.nodesunlimited.agent-user.plist"
		watchdogPlistDst = "/Library/LaunchDaemons/com.nodesunlimited.watchdog.plist"
		binaryPath       = "/usr/local/bin/nu-agent"
		watchdogBinary   = "/usr/local/bin/nu-watchdog"
		configDir        = "/Library/Application Support/Nodes Unlimited"
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
	// The full removal list is DERIVED (payload manifests + static artifacts),
	// so a payload the pkg gains later is torn down without touching this file.
	pkgIDs, payloadPaths := darwinPayloadArtifacts()
	extraPaths := dedupePaths(append(payloadPaths, darwinStaticArtifacts()...))

	script := buildDarwinUninstallScript(darwinUninstallScriptOptions{
		Label:            label,
		WatchdogLabel:    watchdogLabel,
		WatchdogProcess:  "nu-watchdog",
		PlistPath:        plistDst,
		BinaryPath:       binaryPath,
		ConfigDir:        configDir,
		RemoveConfig:     removeConfig,
		DelaySeconds:     uninstallHelperDelaySeconds,
		ExtraPaths:       extraPaths,
		PkgIDs:           pkgIDs,
		LaunchdLabels:    darwinLaunchdLabels(),
		KeychainServices: darwinKeychainServices(),
		VerifyLogPath:    DarwinUninstallLogPath,
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
		serviceName     = "nu-agent"
		watchdogService = "nu-watchdog"
		unitDst         = "/etc/systemd/system/nu-agent.service"
		watchdogUnitDst = "/etc/systemd/system/nu-watchdog.service"
		userUnitDst     = "/usr/lib/systemd/user/nu-agent-user.service"
		binaryPath      = "/usr/local/bin/nu-agent"
		watchdogBinary  = "/usr/local/bin/nu-watchdog"
		configDir       = "/etc/nodesunlimited"
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
	// lives in the nu-agent.service CGROUP, and the unit runs
	// KillMode=mixed — when `systemctl stop nu-agent` runs, systemd
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
		WatchdogProcess: "nu-watchdog",
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
		"Get-Process -Name 'nu-agent','nu-user-helper','nu-desktop-helper','nu-watchdog' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
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
		WatchdogBinaryPath: filepath.Join(filepath.Dir(exePath), "nu-watchdog.exe"),
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
