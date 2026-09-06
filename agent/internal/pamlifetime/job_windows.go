//go:build windows

package pamlifetime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/pamactuator"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	jobObjectQuery     = 0x0004
	jobObjectTerminate = 0x0008
	// stillActiveExitCode is STILL_ACTIVE: GetExitCodeProcess reports it for a
	// process that has not exited. golang.org/x/sys/windows does not export it.
	stillActiveExitCode uint32 = 259
)

var (
	kernel32Job       = windows.NewLazySystemDLL("kernel32.dll")
	procOpenJobObject = kernel32Job.NewProc("OpenJobObjectW")
)

type nativeWindowsPrimitives struct {
	bootOnce sync.Once
	bootID   string
	bootErr  error
}

func (p *nativeWindowsPrimitives) CurrentBootID(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	p.bootOnce.Do(func() {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE,
			`SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`, registry.QUERY_VALUE)
		if err != nil {
			p.bootErr = fmt.Errorf("open Windows boot identity registry key: %w", err)
			return
		}
		defer key.Close()
		bootID, _, err := key.GetIntegerValue("BootId")
		if err != nil {
			p.bootErr = fmt.Errorf("read Windows BootId: %w", err)
			return
		}
		p.bootID = fmt.Sprintf("windows-%d", bootID)
	})
	return p.bootID, p.bootErr
}

func (*nativeWindowsPrimitives) PinTarget(ctx context.Context, path string, expectedHash *string) (string, string, func(), error) {
	if err := ctx.Err(); err != nil {
		return "", "", nil, err
	}
	if !filepath.IsAbs(path) {
		return "", "", nil, errors.New("PAM target path must be absolute")
	}
	canonical, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", "", nil, fmt.Errorf("resolve PAM target: %w", err)
	}
	canonicalPtr, err := windows.UTF16PtrFromString(canonical)
	if err != nil {
		return "", "", nil, fmt.Errorf("encode PAM target path: %w", err)
	}
	handle, err := windows.CreateFile(canonicalPtr, windows.GENERIC_READ, windows.FILE_SHARE_READ,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return "", "", nil, fmt.Errorf("pin PAM target: %w", err)
	}
	file := os.NewFile(uintptr(handle), canonical)
	if file == nil {
		windows.CloseHandle(handle)
		return "", "", nil, errors.New("pin PAM target: create file owner")
	}
	var closeOnce sync.Once
	release := func() { closeOnce.Do(func() { _ = file.Close() }) }
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		release()
		return "", "", nil, errors.New("PAM target must be a regular executable file")
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		release()
		return "", "", nil, fmt.Errorf("hash PAM target: %w", err)
	}
	hash := hex.EncodeToString(hasher.Sum(nil))
	if expectedHash != nil && !strings.EqualFold(strings.TrimSpace(*expectedHash), hash) {
		release()
		return "", "", nil, errors.New("PAM target SHA-256 does not match command")
	}
	return canonical, hash, release, nil
}

func (*nativeWindowsPrimitives) CreateSuspended(ctx context.Context, spec suspendedLaunchSpec) (suspendedProcessOwnership, error) {
	process, err := pamactuator.LaunchSuspendedV2(ctx, pamactuator.SuspendedLaunchRequest{
		ActuationID: spec.actuationID, Username: spec.username, Password: spec.password,
		TargetPath: spec.targetPath, SubjectUsername: spec.subjectUsername,
	})
	if err != nil {
		return suspendedProcessOwnership{}, err
	}
	return suspendedProcessOwnership{
		Identity:      ProcessIdentity{PID: int(process.PID()), ProcessCreationTime: process.ProcessCreationTime(), WindowsSessionID: process.SessionID()},
		processHandle: uintptr(process.ProcessHandle()), threadHandle: uintptr(process.PrimaryThreadHandle()), native: process,
	}, nil
}

func (*nativeWindowsPrimitives) CreateJob(_ context.Context, name string) (jobOwnership, error) {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return jobOwnership{}, err
	}
	handle, err := windows.CreateJobObject(nil, namePtr)
	if err != nil {
		return jobOwnership{}, err
	}
	return jobOwnership{name: name, handle: uintptr(handle), inheritable: false, native: handle}, nil
}

func (*nativeWindowsPrimitives) SetJobLimits(_ context.Context, job jobOwnership, flags uint32) error {
	handle, err := nativeJobHandle(job)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = flags
	_, err = windows.SetInformationJobObject(handle, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	return err
}

func (*nativeWindowsPrimitives) AssignProcess(_ context.Context, job jobOwnership, process suspendedProcessOwnership) error {
	handle, err := nativeJobHandle(job)
	if err != nil {
		return err
	}
	return windows.AssignProcessToJobObject(handle, windows.Handle(process.processHandle))
}

func (*nativeWindowsPrimitives) Resume(_ context.Context, process suspendedProcessOwnership) error {
	count, err := windows.ResumeThread(windows.Handle(process.threadHandle))
	if err != nil {
		return err
	}
	if count == 0xffffffff {
		return errors.New("ResumeThread failed")
	}
	return nil
}

func (*nativeWindowsPrimitives) VerifyActive(_ context.Context, process suspendedProcessOwnership, job jobOwnership) (int, error) {
	if native, ok := process.native.(*pamactuator.SuspendedProcess); !ok || !native.HelperAlive() {
		return 0, errors.New("PAM in-session launch helper is unavailable")
	}
	handle, err := nativeJobHandle(job)
	if err != nil {
		return 0, err
	}
	pids, err := jobProcessIDs(handle)
	if err != nil {
		return 0, err
	}
	found := false
	for _, pid := range pids {
		if int(pid) == process.Identity.PID {
			found = true
			break
		}
	}
	if !found {
		return len(pids), errors.New("launched PID is not owned by PAM Job Object")
	}
	return len(pids), nil
}

func (*nativeWindowsPrimitives) ReopenAndVerifyActive(ctx context.Context, name string, process ProcessIdentity) (jobOwnership, int, error) {
	if err := ctx.Err(); err != nil {
		return jobOwnership{}, 0, err
	}
	handle, _, err := openOwnedJob(name, jobOwnership{})
	if err != nil {
		return jobOwnership{}, 0, err
	}
	closeOnFailure := true
	defer func() {
		if closeOnFailure {
			windows.CloseHandle(handle)
		}
	}()
	pids, err := jobProcessIDs(handle)
	if err != nil {
		return jobOwnership{}, 0, err
	}
	found := false
	for _, pid := range pids {
		if int(pid) == process.PID {
			if err := verifyPIDCreationTime(pid, process.ProcessCreationTime); err != nil {
				return jobOwnership{}, len(pids), err
			}
			found = true
			break
		}
	}
	if !found {
		return jobOwnership{}, len(pids), errors.New("durable PAM PID is not owned by reopened Job Object")
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(handle, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		return jobOwnership{}, len(pids), err
	}
	flags := info.BasicLimitInformation.LimitFlags
	if flags&jobObjectLimitKillOnJobClose == 0 || flags&(jobObjectLimitBreakawayOK|jobObjectLimitSilentBreakawayOK) != 0 {
		return jobOwnership{}, len(pids), errors.New("reopened PAM Job Object has unsafe limits")
	}
	closeOnFailure = false
	return jobOwnership{name: name, handle: uintptr(handle), inheritable: false, limitFlags: flags, native: handle}, len(pids), nil
}

func (*nativeWindowsPrimitives) TerminateAndVerifyEmpty(ctx context.Context, name string, job jobOwnership, process ProcessIdentity) (int, error) {
	handle, owned, err := openOwnedJob(name, job)
	if err != nil {
		return 0, err
	}
	if owned {
		defer windows.CloseHandle(handle)
	}
	if process.PID <= 0 || process.ProcessCreationTime.IsZero() {
		return 0, errors.New("durable process identity is incomplete")
	}
	pids, err := jobProcessIDs(handle)
	if err != nil {
		return 0, err
	}
	for _, pid := range pids {
		if int(pid) != process.PID {
			continue
		}
		if err := verifyPIDCreationTime(pid, process.ProcessCreationTime); err != nil {
			return len(pids), err
		}
	}
	if len(pids) > 0 {
		if err := windows.TerminateJobObject(handle, 1); err != nil {
			return len(pids), err
		}
	}
	for {
		pids, err = jobProcessIDs(handle)
		if err != nil {
			return 0, err
		}
		if len(pids) == 0 {
			return 0, nil
		}
		select {
		case <-ctx.Done():
			return len(pids), ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// VerifyProcessIdentityGone implements rule 2 of the #4196 decision. It
// reports gone=true only on positive evidence that the durable identity no
// longer denotes a running process: the PID does not exist
// (ERROR_INVALID_PARAMETER), the PID was reused by a process with a different
// creation time, or the exact process is held open by another handle but has
// exited (exit code != STILL_ACTIVE). The exact identity still running returns
// gone=false with a nil error; anything the kernel would not let us inspect
// returns an error so the caller stays fail-closed.
func (*nativeWindowsPrimitives) VerifyProcessIdentityGone(ctx context.Context, process ProcessIdentity) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if process.PID <= 0 || process.ProcessCreationTime.IsZero() {
		return false, errors.New("durable process identity is incomplete")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(process.PID))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return true, nil
		}
		return false, fmt.Errorf("open process %d while verifying PAM identity absence: %w", process.PID, err)
	}
	defer windows.CloseHandle(handle)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return false, fmt.Errorf("query process %d times while verifying PAM identity absence: %w", process.PID, err)
	}
	if actual := time.Unix(0, created.Nanoseconds()).UTC(); !actual.Equal(process.ProcessCreationTime.UTC()) {
		return true, nil
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
		return false, fmt.Errorf("query process %d exit code while verifying PAM identity absence: %w", process.PID, err)
	}
	return exitCode != stillActiveExitCode, nil
}

func (*nativeWindowsPrimitives) VerifyNoPrivilegedToken(ctx context.Context, username string) (bool, error) {
	// Do NOT special-case "no such account" here, however tempting it looks:
	// an unresolvable name is not on its own proof that no token exists. A
	// Windows process keeps its token, and therefore the elevated SID, after
	// the account behind it is deleted, so on a host that HAS actuated, this
	// error can be the only trace of exactly the orphaned elevated process
	// this scan exists to catch. The one context where absence is genuinely
	// proof — an agent whose ledger has never recorded an actuation, so the
	// account was never created — is handled by the caller, which knows that:
	// see verifyAccountClean's neverActuated parameter in manager.go (#4587).
	targetSID, _, _, err := windows.LookupSID("", username)
	if err != nil {
		return false, err
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return false, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		process, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
		if openErr == nil {
			var token windows.Token
			if tokenErr := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); tokenErr == nil {
				user, userErr := token.GetTokenUser()
				token.Close()
				windows.CloseHandle(process)
				if userErr != nil {
					return false, userErr
				}
				if windows.EqualSid(user.User.Sid, targetSID) {
					return true, nil
				}
			} else {
				windows.CloseHandle(process)
				return false, tokenInspectionFailure(entry.ProcessID, tokenErr)
			}
		} else if entry.ProcessID != 0 {
			return false, fmt.Errorf("open process %d while verifying PAM token absence: %w", entry.ProcessID, openErr)
		}
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			if errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
				break
			}
			return false, err
		}
	}
	return false, nil
}

func (*nativeWindowsPrimitives) CloseProcess(process suspendedProcessOwnership) {
	if native, ok := process.native.(*pamactuator.SuspendedProcess); ok {
		native.Close()
	}
}

func (*nativeWindowsPrimitives) ClosePrimaryThread(process suspendedProcessOwnership) {
	if native, ok := process.native.(*pamactuator.SuspendedProcess); ok {
		native.ClosePrimaryThread()
	}
}

func (*nativeWindowsPrimitives) CloseJob(job jobOwnership) {
	if handle, err := nativeJobHandle(job); err == nil && handle != 0 {
		windows.CloseHandle(handle)
	}
}

func nativeJobHandle(job jobOwnership) (windows.Handle, error) {
	if handle, ok := job.native.(windows.Handle); ok && handle != 0 {
		return handle, nil
	}
	if job.handle != 0 {
		return windows.Handle(job.handle), nil
	}
	return 0, errors.New("PAM Job Object handle unavailable")
}

func openOwnedJob(name string, job jobOwnership) (windows.Handle, bool, error) {
	if handle, err := nativeJobHandle(job); err == nil {
		return handle, false, nil
	}
	if name == "" {
		return 0, false, errors.New("durable PAM Job Object name unavailable")
	}
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, false, err
	}
	handle, _, callErr := procOpenJobObject.Call(jobObjectQuery|jobObjectTerminate, 0, uintptr(unsafe.Pointer(namePtr)))
	if handle == 0 {
		if errors.Is(callErr, windows.ERROR_FILE_NOT_FOUND) {
			// The named object no longer exists at all. Only this code maps to
			// the sentinel; access denied and every other failure stay opaque
			// so cleanup keeps treating them as unverifiable.
			return 0, false, fmt.Errorf("%w: OpenJobObjectW(%s): %w", ErrJobObjectAbsent, name, callErr)
		}
		return 0, false, callErr
	}
	return windows.Handle(handle), true, nil
}

func jobProcessIDs(job windows.Handle) ([]uintptr, error) {
	buffer := make([]byte, 8+unsafe.Sizeof(uintptr(0))*1024)
	if err := windows.QueryInformationJobObject(job, windows.JobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&buffer[0])), uint32(len(buffer)), nil); err != nil {
		return nil, err
	}
	assigned := *(*uint32)(unsafe.Pointer(&buffer[0]))
	listed := *(*uint32)(unsafe.Pointer(&buffer[4]))
	if assigned != listed {
		return nil, errors.New("PAM Job Object process list was truncated")
	}
	start := unsafe.Pointer(&buffer[8])
	return append([]uintptr(nil), unsafe.Slice((*uintptr)(start), listed)...), nil
}

func verifyPIDCreationTime(pid uintptr, expected time.Time) error {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		return err
	}
	actual := time.Unix(0, created.Nanoseconds()).UTC()
	if !actual.Equal(expected.UTC()) {
		return errors.New("PID creation time no longer matches durable PAM identity")
	}
	return nil
}
