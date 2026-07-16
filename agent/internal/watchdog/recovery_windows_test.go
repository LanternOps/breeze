//go:build windows

package watchdog

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// These tests exercise the concrete Windows adapters against real OS objects
// (the running test process) and against injected syscall seams. The OS-neutral
// state machine they feed is tested in recovery_windows_logic_test.go.

func TestConfiguredExecutablePath(t *testing.T) {
	tests := []struct {
		name    string
		command string
		want    string
	}{
		{"quoted with argument", `"C:\Program Files\Breeze\breeze-agent.exe" run`, `C:\Program Files\Breeze\breeze-agent.exe`},
		{"unquoted with argument", `C:\Breeze\breeze-agent.exe run`, `C:\Breeze\breeze-agent.exe`},
		{"no argument", `C:\Breeze\breeze-agent.exe`, `C:\Breeze\breeze-agent.exe`},
		{"surrounding whitespace", `   "C:\Breeze\breeze-agent.exe"  run  `, `C:\Breeze\breeze-agent.exe`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := configuredExecutablePath(tt.command)
			if err != nil || !sameWindowsExecutable(got, tt.want) {
				t.Fatalf("configuredExecutablePath(%q)=%q,%v want %q", tt.command, got, err, tt.want)
			}
		})
	}
}

// TestConfiguredExecutablePathRejectsUnusable: a path we cannot resolve to a
// single absolute image is "we do not know what the service runs". Returning a
// best guess here would feed the identity gate that authorizes termination.
func TestConfiguredExecutablePathRejectsUnusable(t *testing.T) {
	for _, command := range []string{``, `   `, `"" run`, `breeze-agent.exe run`, `..\breeze-agent.exe`} {
		got, err := configuredExecutablePath(command)
		if err == nil {
			t.Fatalf("configuredExecutablePath(%q)=%q, want an error", command, got)
		}
	}
}

func TestWindowsServiceStateMapping(t *testing.T) {
	tests := []struct {
		state svc.State
		want  serviceState
	}{
		{svc.Stopped, serviceStopped},
		{svc.StartPending, serviceStartPending},
		{svc.StopPending, serviceStopPending},
		{svc.Running, serviceRunning},
		{svc.ContinuePending, serviceContinuePending},
		{svc.PausePending, servicePausePending},
		{svc.Paused, servicePaused},
	}
	for _, tt := range tests {
		got, err := windowsServiceState(tt.state)
		if err != nil || got != tt.want {
			t.Fatalf("windowsServiceState(%d)=%q,%v want %q", tt.state, got, err, tt.want)
		}
	}
	// An SCM state we do not recognize is uncertainty, and uncertainty must not
	// be mapped onto a state the machine would act on.
	if got, err := windowsServiceState(svc.State(99)); err == nil {
		t.Fatalf("windowsServiceState(99)=%q, want an error", got)
	}
}

func openTestProcess(t *testing.T) *windowsProcess {
	t.Helper()
	proc, err := openWindowsProcess(os.Getpid())
	if err != nil {
		t.Fatalf("openWindowsProcess(self): %v", err)
	}
	t.Cleanup(func() { _ = proc.Close() })
	return proc
}

// TestWindowsWatchedProcessImageAndAlive proves the handle reports this very
// process: a real image path that clears the same identity gate forced recovery
// uses, and a live verdict. Terminate is never called.
func TestWindowsWatchedProcessImageAndAlive(t *testing.T) {
	proc := openTestProcess(t)

	image, err := proc.ImagePath()
	if err != nil || image == "" {
		t.Fatalf("ImagePath()=%q,%v want a nonempty path", image, err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	if !sameWindowsExecutable(self, image) {
		t.Fatalf("ImagePath()=%q, want the same image as %q", image, self)
	}

	alive, err := proc.Alive()
	if err != nil || !alive {
		t.Fatalf("Alive()=%v,%v want true,nil", alive, err)
	}
}

func TestWindowsWatchedProcessWaitTimeout(t *testing.T) {
	proc := openTestProcess(t)

	started := time.Now()
	err := proc.Wait(context.Background(), 200*time.Millisecond)
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("Wait() on a live process returned nil, want a timeout error")
	}
	if isRecoveryCancellation(err) {
		t.Fatalf("Wait() err=%v, want a timeout rather than a cancellation", err)
	}
	if elapsed < 200*time.Millisecond {
		t.Fatalf("Wait() returned after %s, want it to honor the full 200ms timeout", elapsed)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("Wait() returned after %s, want a bounded wait", elapsed)
	}
}

// TestWindowsWatchedProcessWaitCanceled: an SCM stop must interrupt an in-flight
// exit wait rather than block for the whole recovery deadline.
func TestWindowsWatchedProcessWaitCanceled(t *testing.T) {
	proc := openTestProcess(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	started := time.Now()
	err := proc.Wait(ctx, 30*time.Second)
	elapsed := time.Since(started)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait() err=%v, want context.Canceled", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("Wait() took %s to notice cancellation, want it well before the 30s timeout", elapsed)
	}
}

func TestWindowsWatchedProcessCloseIsIdempotent(t *testing.T) {
	proc, err := openWindowsProcess(os.Getpid())
	if err != nil {
		t.Fatalf("openWindowsProcess(self): %v", err)
	}
	if err := proc.Close(); err != nil {
		t.Fatalf("first Close(): %v", err)
	}
	if err := proc.Close(); err != nil {
		t.Fatalf("second Close(): %v, want nil", err)
	}
}

// TestWindowsWatchedProcessRejectsUseAfterClose: a closed handle no longer
// names a verified process, so every operation on it — above all Terminate —
// must fail rather than act on a recycled handle value.
func TestWindowsWatchedProcessRejectsUseAfterClose(t *testing.T) {
	proc, err := openWindowsProcess(os.Getpid())
	if err != nil {
		t.Fatalf("openWindowsProcess(self): %v", err)
	}
	if err := proc.Close(); err != nil {
		t.Fatalf("Close(): %v", err)
	}
	if got, err := proc.ImagePath(); err == nil {
		t.Fatalf("ImagePath() after Close()=%q, want an error", got)
	}
	if alive, err := proc.Alive(); err == nil {
		t.Fatalf("Alive() after Close()=%v, want an error", alive)
	}
	if err := proc.Terminate(); err == nil {
		t.Fatal("Terminate() after Close() returned nil, want an error")
	}
	if err := proc.Wait(context.Background(), time.Second); err == nil {
		t.Fatal("Wait() after Close() returned nil, want an error")
	}
}

func TestWindowsWatchedProcessRejectsInvalidPID(t *testing.T) {
	for _, pid := range []int{0, -1} {
		if proc, err := openWindowsProcess(pid); err == nil {
			_ = proc.Close()
			t.Fatalf("openWindowsProcess(%d) succeeded, want an error", pid)
		}
	}
}

// writeUTF16 fills the caller's buffer the way QueryFullProcessImageName does:
// the string plus a NUL, with *size set to the character count excluding it.
func writeUTF16(buf *uint16, size *uint32, value string) {
	encoded := windows.StringToUTF16(value)
	dst := unsafe.Slice(buf, *size)
	copy(dst, encoded)
	*size = uint32(len(encoded) - 1)
}

// TestWindowsWatchedProcessImagePathGrowsBuffer: a service installed under a
// long path exceeds MAX_PATH. Giving up there would make the identity gate fail
// for exactly the agent it is supposed to recognize.
func TestWindowsWatchedProcessImagePathGrowsBuffer(t *testing.T) {
	proc := openTestProcess(t)

	const want = `C:\Program Files\Breeze\breeze-agent.exe`
	var sizes []uint32
	proc.queryImageName = func(_ windows.Handle, _ uint32, buf *uint16, size *uint32) error {
		sizes = append(sizes, *size)
		if *size < 1024 {
			return windows.ERROR_INSUFFICIENT_BUFFER
		}
		writeUTF16(buf, size, want)
		return nil
	}

	got, err := proc.ImagePath()
	if err != nil {
		t.Fatalf("ImagePath(): %v", err)
	}
	if got != want {
		t.Fatalf("ImagePath()=%q, want %q", got, want)
	}
	if !reflect.DeepEqual(sizes, []uint32{windowsMaxPath, 2 * windowsMaxPath, 4 * windowsMaxPath}) {
		t.Fatalf("buffer sizes=%v, want the buffer to double from MAX_PATH", sizes)
	}
}

// TestWindowsWatchedProcessImagePathBufferGrowthIsBounded: growth stops at the
// Windows path limit instead of looping forever allocating.
func TestWindowsWatchedProcessImagePathBufferGrowthIsBounded(t *testing.T) {
	proc := openTestProcess(t)

	var sizes []uint32
	proc.queryImageName = func(_ windows.Handle, _ uint32, _ *uint16, size *uint32) error {
		sizes = append(sizes, *size)
		return windows.ERROR_INSUFFICIENT_BUFFER
	}

	if got, err := proc.ImagePath(); err == nil {
		t.Fatalf("ImagePath()=%q, want an error once the buffer cannot grow further", got)
	}
	if len(sizes) == 0 || sizes[len(sizes)-1] != windowsMaxLongPath {
		t.Fatalf("buffer sizes=%v, want the last attempt at the %d-character limit", sizes, windowsMaxLongPath)
	}
	if len(sizes) > 10 {
		t.Fatalf("buffer sizes=%v, want a bounded number of attempts", sizes)
	}
}

// TestWindowsWatchedProcessImagePathRejectsImplausibleLength: a length longer
// than the buffer we handed in would make us read past it.
func TestWindowsWatchedProcessImagePathRejectsImplausibleLength(t *testing.T) {
	proc := openTestProcess(t)

	proc.queryImageName = func(_ windows.Handle, _ uint32, _ *uint16, size *uint32) error {
		*size = *size + 1
		return nil
	}
	if got, err := proc.ImagePath(); err == nil {
		t.Fatalf("ImagePath()=%q, want an error for an out-of-range length", got)
	}
}

// TestWindowsWatchedProcessAliveFailsClosed: anything other than a definite
// "signaled" or "still waiting" is uncertainty about whether the process we are
// about to terminate is even alive, so it must error rather than guess.
func TestWindowsWatchedProcessAliveFailsClosed(t *testing.T) {
	tests := []struct {
		name  string
		event uint32
		err   error
	}{
		{"abandoned", windows.WAIT_ABANDONED, nil},
		{"failed", windows.WAIT_FAILED, windows.ERROR_INVALID_HANDLE},
		{"unknown", 0x7fffffff, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			proc := openTestProcess(t)
			proc.waitObject = func(windows.Handle, uint32) (uint32, error) { return tt.event, tt.err }
			if alive, err := proc.Alive(); err == nil {
				t.Fatalf("Alive()=%v,nil want an error", alive)
			}
		})
	}
}

func TestWindowsWatchedProcessAliveReportsExited(t *testing.T) {
	proc := openTestProcess(t)
	proc.waitObject = func(windows.Handle, uint32) (uint32, error) { return windows.WAIT_OBJECT_0, nil }
	alive, err := proc.Alive()
	if err != nil || alive {
		t.Fatalf("Alive()=%v,%v want false,nil for a signaled process handle", alive, err)
	}
}

// TestWindowsWatchedProcessWaitFailsClosed: an unexpected wait result while
// waiting for the terminated process to exit must not be read as "it exited".
func TestWindowsWatchedProcessWaitFailsClosed(t *testing.T) {
	proc := openTestProcess(t)
	proc.waitObject = func(windows.Handle, uint32) (uint32, error) { return windows.WAIT_ABANDONED, nil }
	if err := proc.Wait(context.Background(), time.Second); err == nil || isRecoveryCancellation(err) {
		t.Fatalf("Wait() err=%v, want a hard failure", err)
	}
}

func TestWindowsWatchedProcessWaitReportsExit(t *testing.T) {
	proc := openTestProcess(t)
	proc.waitObject = func(windows.Handle, uint32) (uint32, error) { return windows.WAIT_OBJECT_0, nil }
	if err := proc.Wait(context.Background(), 30*time.Second); err != nil {
		t.Fatalf("Wait()=%v, want nil once the handle is signaled", err)
	}
}

// countingBackendCloser adapts the OS-neutral fake to the closer the production
// controller owns, and proves the SCM handles are released.
type countingBackendCloser struct {
	windowsRecoveryBackend
	closes int
}

func (b *countingBackendCloser) Close() error {
	b.closes++
	return nil
}

// TestNewRecoveryManagerUsesWindowsServiceController proves production wiring:
// RecoveryManager must dispatch to the verified Windows controller, not to the
// unverified restart helpers.
func TestNewRecoveryManagerUsesWindowsServiceController(t *testing.T) {
	rm := NewRecoveryManager(3, time.Minute)
	if _, ok := rm.svc.(osServiceController); !ok {
		t.Fatalf("NewRecoveryManager wired %T, want osServiceController", rm.svc)
	}
}

// TestOSServiceControllerRunsVerifiedForcedRecovery: the production controller
// must route a forced attempt through the verified state machine — SCM's
// current PID, image validation before termination, never the state-file PID.
func TestOSServiceControllerRunsVerifiedForcedRecovery(t *testing.T) {
	backend := forcedRecoverySuccessBackend(200, 300)
	closer := &countingBackendCloser{windowsRecoveryBackend: backend}
	controller := osServiceController{
		openBackend: func() (windowsRecoveryBackendCloser, error) { return closer, nil },
		clk:         newFakeRecoveryClock(),
	}

	result, err := controller.Recover(2, RecoveryRequest{StateFilePID: 999, Context: context.Background()})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(backend.openedPIDs, []int{200, 300}) {
		t.Fatalf("openedPIDs=%v, want [200 300]: the state-file PID 999 must never be opened", backend.openedPIDs)
	}
	if result.Action != RecoveryActionForced || result.Disposition != RecoveryDispositionVerifyHeartbeat || result.NewPID != 300 {
		t.Fatalf("result=%+v", result)
	}
	if closer.closes != 1 {
		t.Fatalf("backend closes=%d, want 1", closer.closes)
	}
}

// TestOSServiceControllerOpenFailureIsRetryable: not reaching SCM at all is a
// query failure, not evidence about process identity, so it must not latch the
// terminal failover disposition.
func TestOSServiceControllerOpenFailureIsRetryable(t *testing.T) {
	controller := osServiceController{
		openBackend: func() (windowsRecoveryBackendCloser, error) { return nil, errors.New("SCM unavailable") },
	}
	result, err := controller.Recover(2, RecoveryRequest{StateFilePID: 999})
	var recoveryErr *RecoveryError
	if !errors.As(err, &recoveryErr) || recoveryErr.Class != RecoveryFailureQuery {
		t.Fatalf("err=%v, want a query failure", err)
	}
	if result.ActionTaken {
		t.Fatalf("result=%+v, want no side effect charged when SCM was never reached", result)
	}
	if result.Disposition == RecoveryDispositionFailover {
		t.Fatalf("disposition=%q, want a retryable disposition", result.Disposition)
	}
}
