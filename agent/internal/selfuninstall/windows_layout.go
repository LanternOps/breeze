package selfuninstall

import (
	"fmt"
	"time"
)

// Windows install layout. The service names, task and install folder are
// fixed across editions and brands (installer/breeze.wxs). Untagged so the
// agent's hand-off (and its tests) share them on every OS.
const (
	AgentServiceName    = "BreezeAgent"
	WatchdogServiceName = "BreezeWatchdog"
	UserHelperTaskName  = `\Breeze\AgentUserHelper`
	// HelperExeName is the copy the helper runs as. It must not match any
	// name the teardown kills (breeze-agent.exe and its siblings).
	HelperExeName = "breeze-uninstall-helper.exe"
	// HelperDirPrefix names the private directory the agent stages the copy
	// in. The helper removes only a directory whose name carries it.
	HelperDirPrefix = "breeze-uninstall-"
	// FinishCommand is the hidden agent subcommand the helper runs.
	FinishCommand = "self-uninstall-finish"
	// HandoffDelay matches the agent's own shutdown schedule
	// (heartbeat.uninstallHelperDelaySeconds, pinned by a test there).
	HandoffDelay = 5 * time.Second
)

var (
	// windowsHelperProcesses are killed once the agent service is down: they
	// hold locks on the files being removed. breeze-agent.exe is among them
	// for a watchdog-respawned agent and for the user-helper fallback, which
	// runs as `breeze-agent.exe user-helper` where breeze-user-helper.exe is
	// missing. The helper's own copy is named so this never hits it.
	windowsHelperProcesses = []string{"breeze-agent.exe", "breeze-watchdog.exe", "breeze-user-helper.exe", "breeze-desktop-helper.exe", "breeze-backup.exe"}
	// windowsAgentProcesses must not be running when the teardown is verified.
	windowsAgentProcesses = []string{"breeze-agent.exe", "breeze-watchdog.exe"}
)

// helperDirEnv carries the helper directory to the cleanup cmd.exe.
const helperDirEnv = "BREEZE_UNINSTALL_HELPER_DIR"

// helperDirCleanupArgs is the cmd.exe argument line that removes the helper's
// directory once the helper has exited (a running image cannot be deleted).
// The path travels in the environment and is read with delayed expansion: cmd
// expands %NAME% anywhere in its command line, quoted or not, so a path inline
// could be rewritten into a different one (same construction as the Quick
// Support self-delete, heartbeat/handlers_support.go). It polls about once a
// second for up to a minute and stops once the directory is gone.
func helperDirCleanupArgs() string {
	ref := `"!` + helperDirEnv + `!"`
	return fmt.Sprintf(`/V:ON /D /C for /L %%i in (1,1,60) do (ping 127.0.0.1 -n 2 >NUL & rmdir /s /q %s 2>NUL & if not exist %s exit)`, ref, ref)
}
