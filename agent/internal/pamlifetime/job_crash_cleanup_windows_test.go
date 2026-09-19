//go:build windows

package pamlifetime

import (
	"context"
	"errors"
	"os/exec"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/windows"
)

// Lab-VM tests for the #4196 native primitives. They use their own job names
// and short-lived child processes only; nothing here touches the installed
// agent, its services, or C:\ProgramData\Breeze.

func testJobName() string {
	return `Global\Breeze.PAMTest4196.` + uuid.NewString()
}

// TestOpenOwnedJobReportsAbsentJobObjectDistinctly proves the sentinel is
// specific: a never-created name maps to ErrJobObjectAbsent (wrapping
// ERROR_FILE_NOT_FOUND), and the same name, once created, opens without it.
func TestOpenOwnedJobReportsAbsentJobObjectDistinctly(t *testing.T) {
	name := testJobName()

	_, owned, err := openOwnedJob(name, jobOwnership{})
	if err == nil {
		t.Fatalf("openOwnedJob(%q) on a never-created name succeeded", name)
	}
	if owned {
		t.Fatal("failed open reported an owned handle")
	}
	if !errors.Is(err, ErrJobObjectAbsent) {
		t.Fatalf("openOwnedJob(never-created) error = %v (%T), want errors.Is ErrJobObjectAbsent", err, err)
	}
	if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		t.Fatalf("absent sentinel must wrap the syscall error: %v", err)
	}

	// Control: create the object, then the same open must succeed.
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	created, err := windows.CreateJobObject(nil, namePtr)
	if err != nil {
		t.Fatalf("create control job %q: %v", name, err)
	}
	defer windows.CloseHandle(created)
	handle, owned, err := openOwnedJob(name, jobOwnership{})
	if err != nil {
		t.Fatalf("openOwnedJob(existing) = %v, want success", err)
	}
	if !owned || handle == 0 {
		t.Fatalf("openOwnedJob(existing) owned/handle = %v/%v", owned, handle)
	}
	windows.CloseHandle(handle)
}

// TestOpenOwnedJobKeepsNonAbsentFailuresUnwrapped: an unencodable name fails
// before OpenJobObjectW and must not be mistaken for an absent job.
func TestOpenOwnedJobKeepsNonAbsentFailuresUnwrapped(t *testing.T) {
	_, _, err := openOwnedJob("bad\x00name", jobOwnership{})
	if err == nil {
		t.Fatal("expected encoding failure")
	}
	if errors.Is(err, ErrJobObjectAbsent) {
		t.Fatalf("encoding failure was reported as an absent job: %v", err)
	}
}

func startChild(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(args[0], args[1:]...)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %v: %v", args, err)
	}
	return cmd
}

// processTimes reads the kernel creation time for a PID while the process
// object is still reachable.
func processCreationTime(t *testing.T, pid int) time.Time {
	t.Helper()
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatalf("open pid %d: %v", pid, err)
	}
	defer windows.CloseHandle(handle)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		t.Fatalf("GetProcessTimes(%d): %v", pid, err)
	}
	return time.Unix(0, created.Nanoseconds()).UTC()
}

func TestVerifyProcessIdentityGoneLiveExactMatchIsNotGone(t *testing.T) {
	child := startChild(t, "ping", "-n", "60", "127.0.0.1")
	defer func() { _ = child.Process.Kill(); _, _ = child.Process.Wait() }()
	identity := ProcessIdentity{PID: child.Process.Pid, ProcessCreationTime: processCreationTime(t, child.Process.Pid)}

	gone, err := (&nativeWindowsPrimitives{}).VerifyProcessIdentityGone(context.Background(), identity)

	if err != nil {
		t.Fatalf("VerifyProcessIdentityGone(live exact) error = %v", err)
	}
	if gone {
		t.Fatalf("live child pid %d with matching creation time reported gone", identity.PID)
	}
}

func TestVerifyProcessIdentityGoneLivePIDWithWrongCreationTimeIsGone(t *testing.T) {
	child := startChild(t, "ping", "-n", "60", "127.0.0.1")
	defer func() { _ = child.Process.Kill(); _, _ = child.Process.Wait() }()
	actual := processCreationTime(t, child.Process.Pid)
	identity := ProcessIdentity{PID: child.Process.Pid, ProcessCreationTime: actual.Add(-time.Second)}

	gone, err := (&nativeWindowsPrimitives{}).VerifyProcessIdentityGone(context.Background(), identity)

	if err != nil {
		t.Fatalf("VerifyProcessIdentityGone(pid reused) error = %v", err)
	}
	if !gone {
		t.Fatalf("pid %d with a different creation time was reported alive", identity.PID)
	}
}

func TestVerifyProcessIdentityGoneExitedChildIsGone(t *testing.T) {
	child := startChild(t, "cmd", "/c", "exit", "0")
	pid := child.Process.Pid
	created := processCreationTime(t, pid)
	if err := child.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	// After Wait the runtime has released its handle; the PID is either free
	// (no such PID) or already reused (creation time differs). Both are gone.
	identity := ProcessIdentity{PID: pid, ProcessCreationTime: created}

	gone, err := (&nativeWindowsPrimitives{}).VerifyProcessIdentityGone(context.Background(), identity)

	if err != nil {
		t.Fatalf("VerifyProcessIdentityGone(exited) error = %v", err)
	}
	if !gone {
		t.Fatalf("exited child pid %d was reported alive", pid)
	}
}

// TestVerifyProcessIdentityGoneExitedChildHeldOpenIsGone covers the zombie
// branch: a handle held elsewhere keeps the PID and the exact creation time
// reachable after exit, so only the exit code distinguishes it from a live
// process.
func TestVerifyProcessIdentityGoneExitedChildHeldOpenIsGone(t *testing.T) {
	child := startChild(t, "cmd", "/c", "exit", "0")
	pid := child.Process.Pid
	holder, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatalf("hold pid %d: %v", pid, err)
	}
	defer windows.CloseHandle(holder)
	created := processCreationTime(t, pid)
	if err := child.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	// Control the measurement: the held handle must keep the process object
	// (and its PID) reachable, otherwise this exercises the no-such-PID branch.
	probe, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatalf("control: held pid %d is no longer openable: %v", pid, err)
	}
	windows.CloseHandle(probe)
	identity := ProcessIdentity{PID: pid, ProcessCreationTime: created}

	gone, err := (&nativeWindowsPrimitives{}).VerifyProcessIdentityGone(context.Background(), identity)

	if err != nil {
		t.Fatalf("VerifyProcessIdentityGone(zombie) error = %v", err)
	}
	if !gone {
		t.Fatalf("exited child pid %d held open by another handle was reported alive", pid)
	}
}

func TestVerifyProcessIdentityGoneRejectsIncompleteIdentity(t *testing.T) {
	gone, err := (&nativeWindowsPrimitives{}).VerifyProcessIdentityGone(context.Background(), ProcessIdentity{PID: 0})
	if err == nil || gone {
		t.Fatalf("incomplete identity = gone %v, err %v; want error and not gone", gone, err)
	}
}
