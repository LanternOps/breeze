package selfuninstall

import (
	"strings"
	"time"
)

const (
	helperLogName = "self-uninstall.log"
	msiLogName    = "self-uninstall-msi.log"
)

// Exit codes of the helper process (diagnostics only; nobody waits on it).
const (
	ExitCompleted       = 0
	ExitFailed          = 1
	ExitNotReported     = 2
	ExitFailedNotReport = 3
)

// HelperArgs are what the agent passes the detached helper.
type HelperArgs struct {
	CommandID    string
	AgentBinary  string // the installed breeze-agent.exe
	RemoveConfig bool
	ConfigDir    string // ProgramData\Breeze
}

// WindowsHelperOptions is the helper's teardown for the installed layout.
// Paths are Windows paths whatever the build host, so they are joined with
// backslashes explicitly (this is unit-tested off Windows).
func WindowsHelperOptions(args HelperArgs, onAgentStopped func() error) WindowsOptions {
	installDir := winDir(args.AgentBinary)
	opts := WindowsOptions{
		AgentService:    AgentServiceName,
		WatchdogService: WatchdogServiceName,
		AgentBinary:     args.AgentBinary,
		// The agent binary last: it runs `containment release-all` and is
		// the one most likely still locked.
		Binaries: []string{
			winJoin(installDir, "breeze-watchdog.exe"),
			winJoin(installDir, "breeze-user-helper.exe"),
			winJoin(installDir, "breeze-desktop-helper.exe"),
			winJoin(installDir, "breeze-backup.exe"),
			args.AgentBinary,
		},
		UserHelperTask:        UserHelperTaskName,
		ConfigDir:             args.ConfigDir,
		RemoveConfig:          args.RemoveConfig,
		UpgradeCodes:          AgentUpgradeCodes,
		HandoffDelay:          HandoffDelay,
		HelperProcesses:       windowsHelperProcesses,
		AgentProcesses:        windowsAgentProcesses,
		MSIBusyRetries:        3,
		MSIBusyRetryDelay:     20 * time.Second,
		ProcessSettleAttempts: 3,
		ProcessSettleDelay:    2 * time.Second,
		OnAgentStopped:        onAgentStopped,
	}
	if args.ConfigDir != "" {
		opts.MSILogPath = winJoin(winJoin(args.ConfigDir, "logs"), msiLogName)
	}
	return opts
}

// HelperExitCode maps the outcome and whether it was reported to the
// helper's exit code.
func HelperExitCode(out Outcome, reportErr error) int {
	switch {
	case out.Status == StatusCompleted && reportErr == nil:
		return ExitCompleted
	case out.Status == StatusCompleted:
		return ExitNotReported
	case reportErr == nil:
		return ExitFailed
	default:
		return ExitFailedNotReport
	}
}

func winJoin(dir, name string) string {
	if dir == "" {
		return name
	}
	return strings.TrimRight(dir, `\/`) + `\` + name
}

func winDir(path string) string {
	if i := strings.LastIndexAny(path, `\/`); i >= 0 {
		return path[:i]
	}
	return ""
}
