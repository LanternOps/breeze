//go:build windows

package userhelpertask

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
	"github.com/breeze-rmm/agent/internal/selfuninstall"
	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
	"golang.org/x/sys/windows"
)

// schtasksTimeout bounds every schtasks.exe call.
const schtasksTimeout = 30 * time.Second

// NewWindows returns the production Repairer. dataDir is the agent's
// SYSTEM-only data directory, where the task file is written for schtasks to
// read; uninstalling reports an uninstall in progress.
func NewWindows(dataDir string, uninstalling func() (bool, error)) *Repairer {
	return New(Deps{
		TaskExists:    func() (bool, error) { return selfuninstall.ScheduledTaskExists(TaskName) },
		HelperPresent: helperPresent,
		Uninstalling:  uninstalling,
		Schtasks:      runSchtasks,
		RunState:      taskRunState,
		TempDir:       dataDir,
		Now:           time.Now,
	})
}

// helperPresent: a non-empty regular file. A missing file is absent; any
// other stat failure is unknown.
func helperPresent(path string) (bool, error) {
	if path == "" {
		return false, errors.New("no helper path in the task definition")
	}
	info, err := os.Stat(path)
	switch {
	case err == nil:
		return info.Mode().IsRegular() && info.Size() > 0, nil
	case errors.Is(err, os.ErrNotExist):
		return false, nil
	default:
		return false, err
	}
}

// runSchtasks runs schtasks.exe from the system directory (never PATH) and
// returns its standard output.
func runSchtasks(args ...string) ([]byte, error) {
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, fmt.Errorf("resolve the system directory: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), schtasksTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, filepath.Join(systemDir, "schtasks.exe"), args...)
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("schtasks timed out after %s", schtasksTimeout)
		}
		if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
			return nil, fmt.Errorf("%w: %s", err, truncate(strings.TrimSpace(string(exitErr.Stderr)), 300))
		}
		return nil, err
	}
	return out, nil
}

// COM HRESULTs from CoInitializeEx that are not failures.
const (
	hrSFalse          = 0x1        // S_FALSE: already initialized on this thread; still owes CoUninitialize
	hrRPCChangedMode  = 0x80010106 // RPC_E_CHANGED_MODE: initialized in the other model; usable, not ours to undo
	taskSchedulerProg = "Schedule.Service"
)

// taskRunState reads the task's TASK_STATE through the Task Scheduler COM API
// (ITaskService -> ITaskFolder.GetTask -> IRegisteredTask.State), the
// interface Get-ScheduledTask and schtasks.exe use. It is a read: nothing is
// run or written. The value is a number, so it does not depend on the display
// language, unlike schtasks text output.
//
// Failing to reach Task Scheduler (COM, CreateObject, Connect) is an error:
// the probe did not run. Once connected, any failure to get the task or its
// state is a *StateReadError: the service answered and cannot report the
// task, which is what the half-deleted state looks like (Get-ScheduledTask
// fails there with 0x80070057).
func taskRunState() (RunState, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		var oleErr *ole.OleError
		if !errors.As(err, &oleErr) {
			return 0, fmt.Errorf("initialize COM: %w", err)
		}
		switch uint32(oleErr.Code()) {
		case hrSFalse:
			defer ole.CoUninitialize()
		case hrRPCChangedMode:
		default:
			return 0, fmt.Errorf("initialize COM: %w", err)
		}
	} else {
		defer ole.CoUninitialize()
	}

	unknown, err := oleutil.CreateObject(taskSchedulerProg)
	if err != nil {
		return 0, fmt.Errorf("create the Task Scheduler client: %w", oleErrorDetail(err))
	}
	defer unknown.Release()
	service, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return 0, fmt.Errorf("query the Task Scheduler client: %w", oleErrorDetail(err))
	}
	defer service.Release()
	if _, err := oleutil.CallMethod(service, "Connect"); err != nil {
		return 0, fmt.Errorf("connect to Task Scheduler: %w", oleErrorDetail(err))
	}

	folderPath, leaf := taskFolderAndLeaf()
	folderV, err := oleutil.CallMethod(service, "GetFolder", folderPath)
	if err != nil {
		return StateUnreadable, &StateReadError{Err: fmt.Errorf("get folder %s: %w", folderPath, oleErrorDetail(err))}
	}
	folder := folderV.ToIDispatch()
	if folder == nil {
		return StateUnreadable, &StateReadError{Err: fmt.Errorf("get folder %s: no object", folderPath)}
	}
	defer folder.Release()
	taskV, err := oleutil.CallMethod(folder, "GetTask", leaf)
	if err != nil {
		return StateUnreadable, &StateReadError{Err: fmt.Errorf("get task: %w", oleErrorDetail(err))}
	}
	task := taskV.ToIDispatch()
	if task == nil {
		return StateUnreadable, &StateReadError{Err: errors.New("get task: no object")}
	}
	defer task.Release()
	stateV, err := oleutil.GetProperty(task, "State")
	if err != nil {
		return StateUnreadable, &StateReadError{Err: fmt.Errorf("get task state: %w", oleErrorDetail(err))}
	}
	defer func() { _ = stateV.Clear() }()
	switch v := stateV.Value().(type) {
	case int32:
		return RunState(v), nil
	case int64:
		return RunState(v), nil
	case int16:
		return RunState(v), nil
	case uint32:
		return RunState(v), nil
	default:
		return StateUnreadable, &StateReadError{Err: fmt.Errorf("get task state: unexpected variant type %d", stateV.VT)}
	}
}

// oleErrorDetail adds the HRESULT, and the exception's own code when the call
// failed with DISP_E_EXCEPTION, to a COM error for the log.
func oleErrorDetail(err error) error {
	var oleErr *ole.OleError
	if !errors.As(err, &oleErr) {
		return err
	}
	if info, ok := oleErr.SubError().(ole.EXCEPINFO); ok && info.SCODE() != 0 {
		return fmt.Errorf("HRESULT %#x, scode %#x: %w", uint32(oleErr.Code()), info.SCODE(), err)
	}
	return fmt.Errorf("HRESULT %#x: %w", uint32(oleErr.Code()), err)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
