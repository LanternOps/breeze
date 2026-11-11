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
	// Where the log ends up (decided once the outcome is known):
	//   - config dir still in place (a failure, or removeConfig=false): copied
	//     next to the agent's logs, a folder the installed agent owns;
	//   - config dir removed by this run and the outcome reported: dropped,
	//     the reported result is the record;
	//   - config dir removed and the outcome NOT reported: kept in this
	//     helper's private SYSTEM/Administrators-only folder, which is then
	//     left in place. ProgramData\Breeze is never recreated for it: a
	//     folder made there inherits ProgramData's ACL, which lets any user
	//     plant a junction and redirect a SYSTEM write.
	configRemoved, keepPrivateLog := false, false
	defer func() {
		if !configRemoved {
			persistLog(logPath, args.ConfigDir)
		}
		logging.DiscardOutput()
		if logFile != nil {
			_ = logFile.Close()
		}
		if keepPrivateLog {
			keepHelperDirForLog(helperDir)
			return
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

	// Read the credentials again once the agent is down (it can no longer
	// rotate them) and before anything deletes secrets.yaml. A first read
	// that failed is recovered here.
	refreshCredentials := func() error {
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
	}

	plan := BuildWindowsPlan(WindowsHelperOptions(args, refreshCredentials), NewWindowsOps())
	plan.Report = func(ctx context.Context, o Outcome) error {
		if reporter == nil {
			return ErrNoReporter
		}
		return reporter.Report(ctx, o)
	}

	// Bounded overall, so a wedged step ends as a failed, reported run.
	ctx, cancel := context.WithTimeout(context.Background(), helperDeadline)
	defer cancel()
	out, reportErr := Run(ctx, plan)
	logOutcome(out, reportErr)
	// An outcome the server never heard of must leave evidence on the device,
	// even after a completed uninstall removed the config dir.
	configRemoved, _ = out.Details[detailConfigRemoved].(bool)
	keepPrivateLog = configRemoved && reportErr != nil
	if keepPrivateLog {
		log.Error("self-uninstall outcome not reported; this log is kept in the helper's folder", "path", logPath)
	}
	return HelperExitCode(out, reportErr)
}

// helperDeadline bounds the whole teardown: msiexec's own 20-minute bound,
// its busy retries, the service waits and the report retries, with room.
const helperDeadline = 45 * time.Minute

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

// persistLog copies the helper's log next to the agent's logs. Called only when
// this run did not remove the config dir, so the folder is the installed
// agent's own (the agent writes its logs there as SYSTEM too); it is never
// created here.
func persistLog(logPath, configDir string) {
	if configDir == "" {
		return
	}
	logsDir := filepath.Join(configDir, "logs")
	if fi, err := os.Lstat(logsDir); err != nil || !fi.IsDir() {
		return // absent, or a link: not the agent's folder
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

// keepHelperDirForLog leaves the helper's private folder (and its log) in
// place and queues only the helper's executable for removal at the next boot,
// the one file a running image cannot delete.
func keepHelperDirForLog(dir string) {
	if dir == "" || !strings.HasPrefix(strings.ToLower(filepath.Base(dir)), HelperDirPrefix) {
		return
	}
	if exe, err := windows.UTF16PtrFromString(filepath.Join(dir, HelperExeName)); err == nil {
		_ = windows.MoveFileEx(exe, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
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
