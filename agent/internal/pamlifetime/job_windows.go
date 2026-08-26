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
	"syscall"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/pamactuator"
	"golang.org/x/sys/windows"
)

const (
	jobObjectQuery     = 0x0004
	jobObjectTerminate = 0x0008
)

var (
	kernel32Job       = windows.NewLazySystemDLL("kernel32.dll")
	procOpenJobObject = kernel32Job.NewProc("OpenJobObjectW")
)

type nativeWindowsPrimitives struct{}

func (*nativeWindowsPrimitives) ValidateTarget(ctx context.Context, path string, expectedHash *string) (string, string, error) {
	if err := ctx.Err(); err != nil {
		return "", "", err
	}
	if !filepath.IsAbs(path) {
		return "", "", errors.New("PAM target path must be absolute")
	}
	canonical, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", "", fmt.Errorf("resolve PAM target: %w", err)
	}
	file, err := os.Open(canonical)
	if err != nil {
		return "", "", fmt.Errorf("open PAM target: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", "", errors.New("PAM target must be a regular executable file")
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", "", fmt.Errorf("hash PAM target: %w", err)
	}
	hash := hex.EncodeToString(hasher.Sum(nil))
	if expectedHash != nil && !strings.EqualFold(strings.TrimSpace(*expectedHash), hash) {
		return "", "", errors.New("PAM target SHA-256 does not match command")
	}
	return canonical, hash, nil
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

func (*nativeWindowsPrimitives) VerifyNoPrivilegedToken(ctx context.Context, username string) (bool, error) {
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
				if !errors.Is(tokenErr, windows.ERROR_ACCESS_DENIED) {
					return false, tokenErr
				}
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
