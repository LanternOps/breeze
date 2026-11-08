//go:build windows

package selfuninstall

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/procspawn"
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

// LoadClient reads the agent's credentials and returns a client that posts
// with them. Called at start and again once the agent has stopped.
type LoadClient func() (ResultSubmitter, error)

// RunWindowsHelper is the body of `breeze-uninstall-helper.exe
// self-uninstall-finish`: it runs the teardown, reports the command result
// only once the teardown is verified, restores the agent on failure, and
// queues its own directory for removal. It returns the process exit code.
func RunWindowsHelper(args HelperArgs, loadClient LoadClient) int {
	start := time.Now()
	helperDir := ""
	if exe, err := os.Executable(); err == nil {
		helperDir = filepath.Dir(exe)
	}
	logPath := filepath.Join(helperDir, helperLogName)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err == nil {
		logging.Init("text", "info", logFile)
	}
	defer func() {
		persistLog(logPath, args.ConfigDir)
		logging.DiscardOutput()
		if logFile != nil {
			_ = logFile.Close()
		}
		removeHelperDir(helperDir)
	}()

	log.Info("self-uninstall helper started", "commandId", args.CommandID, "agentBinary", args.AgentBinary, "removeConfig", args.RemoveConfig)

	var reporter *Reporter
	if client, err := loadClient(); err != nil {
		// Teardown still runs: the operator asked for it. The server never
		// hears a result, so the command expires and a purge needs force.
		log.Error("cannot read the agent credentials; the result will not be reported", "error", err.Error())
	} else {
		reporter = NewReporter(args.CommandID, client, start)
	}

	installDir := filepath.Dir(args.AgentBinary)
	opts := WindowsOptions{
		AgentService:    AgentServiceName,
		WatchdogService: WatchdogServiceName,
		AgentBinary:     args.AgentBinary,
		Binaries: []string{
			filepath.Join(installDir, "breeze-watchdog.exe"),
			filepath.Join(installDir, "breeze-user-helper.exe"),
			filepath.Join(installDir, "breeze-backup.exe"),
			args.AgentBinary,
		},
		UserHelperTask:    UserHelperTaskName,
		ConfigDir:         args.ConfigDir,
		RemoveConfig:      args.RemoveConfig,
		UpgradeCodes:      AgentUpgradeCodes,
		HandoffDelay:      HandoffDelay,
		HelperProcesses:   windowsHelperProcesses,
		AgentProcesses:    windowsAgentProcesses,
		MSIBusyRetries:    3,
		MSIBusyRetryDelay: 20 * time.Second,
		OnAgentStopped: func() error {
			client, err := loadClient()
			if err != nil {
				return err
			}
			if reporter == nil {
				reporter = NewReporter(args.CommandID, client, start)
			} else {
				reporter.SetClient(client)
			}
			return nil
		},
	}
	if args.ConfigDir != "" {
		opts.MSILogPath = filepath.Join(args.ConfigDir, "logs", msiLogName)
	}

	plan := BuildWindowsPlan(opts, NewWindowsOps())
	plan.Report = func(ctx context.Context, o Outcome) error {
		if reporter == nil {
			return ErrNoReporter
		}
		return reporter.Report(ctx, o)
	}

	out, reportErr := Run(context.Background(), plan)
	logOutcome(out, reportErr)
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

func logOutcome(out Outcome, reportErr error) {
	attrs := []any{"status", out.Status, "steps", strings.Join(out.Steps, ","), "details", out.Details, "warnings", out.Warnings}
	if out.Err != nil {
		attrs = append(attrs, "failedStep", out.FailedStep, "error", out.Err.Error())
	}
	if reportErr != nil {
		attrs = append(attrs, "reportError", reportErr.Error())
		log.Error("self-uninstall finished; result NOT reported", attrs...)
		return
	}
	log.Info("self-uninstall finished; result reported", attrs...)
}

// persistLog copies the helper's log next to the agent's logs when the config
// dir still exists (a failure, or removeConfig=false). After a completed
// uninstall that removed it, the reported result is the record.
func persistLog(logPath, configDir string) {
	if configDir == "" {
		return
	}
	logsDir := filepath.Join(configDir, "logs")
	if _, err := os.Stat(logsDir); err != nil {
		return
	}
	src, err := os.Open(logPath)
	if err != nil {
		return
	}
	defer func() { _ = src.Close() }()
	dst, err := os.OpenFile(filepath.Join(logsDir, helperLogName), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = dst.Close() }()
	_, _ = io.Copy(dst, src)
}

// removeHelperDir deletes the helper's private directory once this process
// has exited (a running image cannot delete itself), from a detached cmd.exe.
func removeHelperDir(dir string) {
	if dir == "" || !strings.HasPrefix(strings.ToLower(filepath.Base(dir)), HelperDirPrefix) {
		return // never rmdir anything but the directory the agent made for us
	}
	cmd := procspawn.Command(systemTool("cmd.exe"))
	cmd.SysProcAttr = detachedCmdLine(helperDirCleanupArgs())
	procspawn.Prepare(cmd)
	cmd.Env = append(os.Environ(), helperDirEnv+"="+dir)
	if err := cmd.Start(); err == nil {
		_ = cmd.Process.Release()
	}
}

// detachedCmdLine runs cmd.exe with a verbatim argument line (Go's argument
// quoting does not suit cmd /c), detached and windowless, so it outlives this
// process.
func detachedCmdLine(args string) *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		CmdLine:       `"` + systemTool("cmd.exe") + `" ` + args,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW,
		HideWindow:    true,
	}
}
