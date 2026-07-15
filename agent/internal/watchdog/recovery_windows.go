//go:build windows

package watchdog

import (
	"context"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const agentWindowsServiceName = "BreezeAgent"

const (
	// windowsMaxPath is MAX_PATH, the buffer QueryFullProcessImageName is
	// documented against and the size that satisfies almost every install.
	windowsMaxPath = 260
	// windowsMaxLongPath is the Windows path ceiling (32,767 characters). A
	// buffer that reached it and is still too small means the OS is telling us
	// something we cannot represent, so we stop growing and fail.
	windowsMaxLongPath = 32767

	// windowsProcessWaitSlice bounds a single blocking WaitForSingleObject so
	// the caller's context is re-checked at least this often. Waits during
	// recovery must be interruptible by an SCM stop.
	windowsProcessWaitSlice = 100 * time.Millisecond

	// windowsTerminateExitCode is the exit code recorded for a process the
	// watchdog force-terminates.
	windowsTerminateExitCode = 1
)

// osServiceController is the production serviceController on Windows. It opens
// SCM per attempt and drives the verified recovery state machine in
// recovery_windows_logic.go, which is what makes forced recovery safe: every
// destructive step targets the PID SCM names right now, after the image behind
// it has been proven to be the agent.
//
// The zero value is the production configuration; the fields are test seams.
type osServiceController struct {
	// openBackend is nil in production, where SCM is opened for real.
	openBackend func() (windowsRecoveryBackendCloser, error)
	// clk is nil in production, where waits run on wall-clock time.
	clk recoveryClock
}

// windowsRecoveryBackendCloser is a windowsRecoveryBackend that owns OS handles
// and must be released after an attempt.
type windowsRecoveryBackendCloser interface {
	windowsRecoveryBackend
	Close() error
}

func (c osServiceController) Recover(attempt int, req RecoveryRequest) (RecoveryResult, error) {
	open := c.openBackend
	if open == nil {
		open = func() (windowsRecoveryBackendCloser, error) {
			return openWindowsServiceBackend(agentWindowsServiceName)
		}
	}
	clk := c.clk
	if clk == nil {
		clk = realRecoveryClock{}
	}

	backend, err := open()
	if err != nil {
		// We never reached SCM, so we learned nothing about the service or its
		// process. That is a retryable query failure, not the identity
		// uncertainty that latches terminal failover.
		result := RecoveryResult{
			Intent:       req.Intent,
			StateFilePID: req.StateFilePID,
			Phase:        "open_service",
			Disposition:  RecoveryDispositionNone,
		}
		return result, &RecoveryError{Class: RecoveryFailureQuery, Phase: "open_service", Err: err}
	}
	defer backend.Close()

	return newWindowsRecoveryController(backend, clk).Recover(attempt, req)
}

// windowsServiceBackend is the concrete windowsRecoveryBackend: a live SCM
// connection plus an open handle to the agent's service.
type windowsServiceBackend struct {
	name string
	mgr  *mgr.Mgr
	svc  *mgr.Service
}

func openWindowsServiceBackend(name string) (*windowsServiceBackend, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("connect to SCM: %w", err)
	}
	s, err := m.OpenService(name)
	if err != nil {
		_ = m.Disconnect()
		return nil, fmt.Errorf("open service %q: %w", name, err)
	}
	return &windowsServiceBackend{name: name, mgr: m, svc: s}, nil
}

func (b *windowsServiceBackend) Close() error {
	var errs []error
	if b.svc != nil {
		errs = append(errs, b.svc.Close())
		b.svc = nil
	}
	if b.mgr != nil {
		errs = append(errs, b.mgr.Disconnect())
		b.mgr = nil
	}
	return errors.Join(errs...)
}

func (b *windowsServiceBackend) Query() (serviceSnapshot, error) {
	status, err := b.svc.Query()
	if err != nil {
		return serviceSnapshot{}, fmt.Errorf("query service %q: %w", b.name, err)
	}
	state, err := windowsServiceState(status.State)
	if err != nil {
		return serviceSnapshot{}, fmt.Errorf("service %q: %w", b.name, err)
	}
	return serviceSnapshot{State: state, PID: windowsServicePID(status)}, nil
}

// windowsServicePID converts SCM's process id. SCM reports 0 when the service
// owns no process; anything that would not survive the conversion is reported
// as "no PID", which the state machine already treats as identity uncertainty
// rather than acting on it.
func windowsServicePID(status svc.Status) int {
	if status.ProcessId == 0 || status.ProcessId > math.MaxInt32 {
		return 0
	}
	return int(status.ProcessId)
}

// windowsServiceState maps SCM's state onto the OS-neutral mirror. An
// unrecognized state is an error rather than a default: the state machine
// branches on this value to decide whether to stop, start, or terminate, so
// guessing here would authorize an action on evidence we do not have.
func windowsServiceState(state svc.State) (serviceState, error) {
	switch state {
	case svc.Stopped:
		return serviceStopped, nil
	case svc.StartPending:
		return serviceStartPending, nil
	case svc.StopPending:
		return serviceStopPending, nil
	case svc.Running:
		return serviceRunning, nil
	case svc.ContinuePending:
		return serviceContinuePending, nil
	case svc.PausePending:
		return servicePausePending, nil
	case svc.Paused:
		return servicePaused, nil
	default:
		return "", fmt.Errorf("unrecognized SCM service state %d", uint32(state))
	}
}

func (b *windowsServiceBackend) ConfiguredBinaryPath() (string, error) {
	config, err := b.svc.Config()
	if err != nil {
		return "", fmt.Errorf("read service %q config: %w", b.name, err)
	}
	path, err := configuredExecutablePath(config.BinaryPathName)
	if err != nil {
		return "", fmt.Errorf("service %q: %w", b.name, err)
	}
	return path, nil
}

// configuredExecutablePath extracts the image path from an SCM BinaryPathName,
// which is a full command line: the executable may be quoted (it must be when
// the path contains spaces) and may be followed by arguments.
//
// Every failure mode returns an error rather than a best guess. The returned
// path is the reference the identity gate compares a running process against
// before the watchdog terminates it, so "probably this one" is not an
// acceptable answer.
func configuredExecutablePath(command string) (string, error) {
	trimmed := strings.TrimSpace(command)
	if trimmed == "" {
		return "", errors.New("service config has an empty binary path")
	}
	args, err := windows.DecomposeCommandLine(trimmed)
	if err != nil {
		return "", fmt.Errorf("decompose binary path %q: %w", trimmed, err)
	}
	if len(args) == 0 || strings.TrimSpace(args[0]) == "" {
		return "", fmt.Errorf("binary path %q names no executable", trimmed)
	}
	exe := strings.TrimSpace(args[0])
	if !filepath.IsAbs(exe) {
		// A relative image path would resolve against whatever working
		// directory we happen to have, which is not what SCM launched.
		return "", fmt.Errorf("binary path %q is not absolute", exe)
	}
	full, err := windows.FullPath(exe)
	if err != nil {
		return "", fmt.Errorf("canonicalize binary path %q: %w", exe, err)
	}
	return full, nil
}

func (b *windowsServiceBackend) Stop() error {
	if _, err := b.svc.Control(svc.Stop); err != nil {
		return fmt.Errorf("stop service %q: %w", b.name, err)
	}
	return nil
}

func (b *windowsServiceBackend) Start() error {
	if err := b.svc.Start(); err != nil {
		return fmt.Errorf("start service %q: %w", b.name, err)
	}
	return nil
}

func (b *windowsServiceBackend) OpenProcess(pid int) (watchedProcess, error) {
	return openWindowsProcess(pid)
}

// windowsProcess is a verified handle to one process.
//
// The handle — not the PID — is what every operation acts on. Windows keeps a
// PID reserved for as long as a handle to it is open, so once this handle is
// obtained the identity we validate is the identity we terminate: the PID
// cannot be recycled onto another process underneath us.
type windowsProcess struct {
	// mu serializes every handle operation so Close cannot run concurrently
	// with an in-flight query or wait and hand a closed (potentially recycled)
	// handle value to the OS.
	mu     sync.Mutex
	handle windows.Handle
	pid    int
	closed bool

	// Syscall seams. Nil is never valid: openWindowsProcess sets both.
	queryImageName func(proc windows.Handle, flags uint32, exeName *uint16, size *uint32) error
	waitObject     func(handle windows.Handle, milliseconds uint32) (uint32, error)
}

func openWindowsProcess(pid int) (*windowsProcess, error) {
	// uint64 rather than a bare constant comparison: int is 32-bit on 386/arm,
	// where `pid > math.MaxUint32` does not compile.
	if pid <= 0 || uint64(pid) > math.MaxUint32 {
		return nil, fmt.Errorf("refusing to open a process handle for pid %d", pid)
	}
	access := uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.PROCESS_TERMINATE | windows.SYNCHRONIZE)
	handle, err := windows.OpenProcess(access, false, uint32(pid))
	if err != nil {
		return nil, fmt.Errorf("open process %d: %w", pid, err)
	}
	return &windowsProcess{
		handle:         handle,
		pid:            pid,
		queryImageName: windows.QueryFullProcessImageName,
		waitObject:     windows.WaitForSingleObject,
	}, nil
}

// handleLocked returns the live handle, or an error once the handle is closed.
// A closed handle names nothing; acting on its value could hit an unrelated
// object the OS has since assigned it to.
func (p *windowsProcess) handleLocked() (windows.Handle, error) {
	if p.closed {
		return 0, fmt.Errorf("process handle for pid %d is closed", p.pid)
	}
	return p.handle, nil
}

// ImagePath returns the full image path of the process, growing the buffer from
// MAX_PATH up to the Windows path limit while the OS reports it is too small.
func (p *windowsProcess) ImagePath() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	handle, err := p.handleLocked()
	if err != nil {
		return "", err
	}

	size := uint32(windowsMaxPath)
	for {
		buf := make([]uint16, size)
		length := size
		err := p.queryImageName(handle, 0, &buf[0], &length)
		if err == nil {
			if length == 0 || length > size {
				return "", fmt.Errorf("image name for pid %d has an out-of-range length %d (buffer %d)", p.pid, length, size)
			}
			return windows.UTF16ToString(buf[:length]), nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) || size >= windowsMaxLongPath {
			return "", fmt.Errorf("query image name for pid %d: %w", p.pid, err)
		}
		size *= 2
		if size > windowsMaxLongPath {
			size = windowsMaxLongPath
		}
	}
}

// Alive reports whether the process is still running, using a zero-timeout wait
// on the process handle: a process handle is signaled once the process exits.
//
// Only two results are answers. WAIT_TIMEOUT means "not signaled", so it is
// still running; WAIT_OBJECT_0 means it has exited. Anything else — an
// abandoned wait, WAIT_FAILED, or a value we do not recognize — is uncertainty
// about a process the caller may be about to terminate, so it fails closed.
func (p *windowsProcess) Alive() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	handle, err := p.handleLocked()
	if err != nil {
		return false, err
	}
	event, err := p.waitObject(handle, 0)
	if err != nil {
		return false, fmt.Errorf("wait on process %d: %w", p.pid, err)
	}
	switch event {
	case uint32(windows.WAIT_TIMEOUT):
		return true, nil
	case windows.WAIT_OBJECT_0:
		return false, nil
	default:
		return false, fmt.Errorf("unexpected wait result %#x for process %d", event, p.pid)
	}
}

func (p *windowsProcess) Terminate() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	handle, err := p.handleLocked()
	if err != nil {
		return err
	}
	if err := windows.TerminateProcess(handle, windowsTerminateExitCode); err != nil {
		return fmt.Errorf("terminate process %d: %w", p.pid, err)
	}
	return nil
}

// Wait blocks until the process exits, the timeout elapses, or ctx is canceled.
//
// It polls in short slices rather than issuing one long blocking wait so a
// watchdog shutdown interrupts it promptly: a wait that ignored ctx would pin
// the service-stop handler for the whole recovery deadline.
func (p *windowsProcess) Wait(ctx context.Context, timeout time.Duration) error {
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.Now().Add(timeout)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("timed out after %s waiting for process %d to exit", timeout, p.pid)
		}
		if remaining > windowsProcessWaitSlice {
			remaining = windowsProcessWaitSlice
		}
		event, err := p.waitSlice(remaining)
		if err != nil {
			return err
		}
		switch event {
		case windows.WAIT_OBJECT_0:
			return nil
		case uint32(windows.WAIT_TIMEOUT):
			// Still running; take another slice.
		default:
			return fmt.Errorf("unexpected wait result %#x while waiting for process %d to exit", event, p.pid)
		}
	}
}

// waitSlice performs one bounded blocking wait under the handle lock.
func (p *windowsProcess) waitSlice(d time.Duration) (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	handle, err := p.handleLocked()
	if err != nil {
		return 0, err
	}
	event, err := p.waitObject(handle, waitMilliseconds(d))
	if err != nil {
		return 0, fmt.Errorf("wait on process %d: %w", p.pid, err)
	}
	return event, nil
}

// waitMilliseconds rounds up so a sub-millisecond slice still waits rather than
// spinning.
func waitMilliseconds(d time.Duration) uint32 {
	if d <= 0 {
		return 0
	}
	ms := (d + time.Millisecond - 1) / time.Millisecond
	if ms > math.MaxInt32 {
		return math.MaxInt32
	}
	return uint32(ms)
}

// Close releases the handle. It is idempotent: recovery paths close on every
// exit route, and double-closing a handle whose value the OS may have reused is
// exactly the bug idempotency prevents.
func (p *windowsProcess) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return nil
	}
	p.closed = true
	handle := p.handle
	p.handle = windows.InvalidHandle
	if handle == 0 || handle == windows.InvalidHandle {
		return nil
	}
	if err := windows.CloseHandle(handle); err != nil {
		return fmt.Errorf("close handle for process %d: %w", p.pid, err)
	}
	return nil
}

// restartAgentService and startAgentService are no longer on the Windows
// recovery path — osServiceController drives the verified state machine
// instead. They remain only because the shared escalatingServiceRecover in
// recovery.go references them on every GOOS. Do not wire them into recovery:
// they restart the service without ever proving what process they are acting
// on.
func restartAgentService() error {
	backend, err := openWindowsServiceBackend(agentWindowsServiceName)
	if err != nil {
		return err
	}
	defer backend.Close()

	// Ignore the stop error — the service may already be stopped.
	_ = backend.Stop()

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, err := backend.Query()
		if err != nil {
			return err
		}
		if snapshot.State == serviceStopped {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	return backend.Start()
}

func startAgentService() error {
	backend, err := openWindowsServiceBackend(agentWindowsServiceName)
	if err != nil {
		return err
	}
	defer backend.Close()
	return backend.Start()
}
