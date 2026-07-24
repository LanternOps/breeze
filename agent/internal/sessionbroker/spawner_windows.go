//go:build windows

package sessionbroker

import (
	"fmt"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// SpawnedHelper describes a helper process after a successful spawn. It
// contains the PID and a duplicated process handle so callers can wait for
// the process to exit and inspect its exit code. Close() must be called to
// release the handle.
//
// BinaryPath records the executable the spawner actually launched so callers
// can distinguish the GUI-subsystem sibling (breeze-user-helper.exe) from
// the console-subsystem agent fallback when logging spawn outcomes — useful
// when chasing reports of the logon console flash regression.
type SpawnedHelper struct {
	PID                uint32
	Handle             windows.Handle
	BinaryPath         string
	CommandMode        string
	Role               ipc.HelperRole
	WindowsSessionID   uint32
	MainBinaryFallback bool
	mu                 sync.Mutex
	terminated         bool
	standaloneOwner    *windowsHelperSpawner
	ops                *spawnedHelperOps
}

type spawnedHelperOps struct {
	duplicateProcessHandle func(windows.Handle) (windows.Handle, error)
	waitForSingleObject    func(windows.Handle, uint32) (uint32, error)
	getExitCodeProcess     func(windows.Handle, *uint32) error
	closeHandle            func(windows.Handle) error
	sleep                  func(time.Duration)
}

func defaultSpawnedHelperOps() *spawnedHelperOps {
	return &spawnedHelperOps{
		duplicateProcessHandle: duplicateProcessHandle,
		waitForSingleObject:    windows.WaitForSingleObject,
		getExitCodeProcess:     windows.GetExitCodeProcess,
		closeHandle:            windows.CloseHandle,
		sleep:                  time.Sleep,
	}
}

func (s *SpawnedHelper) processOps() *spawnedHelperOps {
	if s.ops != nil {
		return s.ops
	}
	return defaultSpawnedHelperOps()
}

// Close releases the process handle. Safe to call more than once. It never
// terminates the process: the lifecycle spawner owns the shared Job Object,
// while legacy standalone helpers have a private reaper that closes their Job
// only after observing process exit.
func (s *SpawnedHelper) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	handle := s.Handle
	s.Handle = 0
	s.standaloneOwner = nil
	ops := s.processOps()
	s.mu.Unlock()

	if handle == 0 {
		return nil
	}
	return ops.closeHandle(handle)
}

func (s *SpawnedHelper) ProcessID() uint32      { return s.PID }
func (s *SpawnedHelper) ExecutablePath() string { return s.BinaryPath }

// Alive reports whether the helper process is still running. A non-nil error
// means the state could not be determined; callers must not read that as "dead".
func (s *SpawnedHelper) Alive() (bool, error) {
	if s == nil {
		return false, fmt.Errorf("SpawnedHelper: nil helper")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Handle == 0 {
		// Close() already released the handle; the helper is definitively no
		// longer ours to track. Known-dead, not unknown.
		return false, nil
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(s.Handle, &exitCode); err != nil {
		return false, fmt.Errorf("GetExitCodeProcess: %w", err)
	}
	return exitCode == windowsProcessStillActive, nil
}

func (s *SpawnedHelper) Terminate() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Handle == 0 || s.terminated {
		return nil
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(s.Handle, &exitCode); err != nil {
		return err
	}
	if exitCode != windowsProcessStillActive {
		s.terminated = true
		return nil
	}
	if err := windows.TerminateProcess(s.Handle, 1); err != nil {
		return err
	}
	s.terminated = true
	return nil
}

// Wait blocks until the spawned helper process exits and returns its exit
// code. Returns -1 + error on failure. Wait does not release the process
// handle; the lifecycle watcher calls Close after Wait returns.
func (s *SpawnedHelper) Wait() (int, error) {
	if s == nil {
		return -1, fmt.Errorf("SpawnedHelper: no handle")
	}
	s.mu.Lock()
	if s.Handle == 0 {
		s.mu.Unlock()
		return -1, fmt.Errorf("SpawnedHelper: no handle")
	}
	ops := s.processOps()
	waitHandle, err := ops.duplicateProcessHandle(s.Handle)
	s.mu.Unlock()
	if err != nil {
		return -1, fmt.Errorf("duplicate process handle for wait: %w", err)
	}
	defer ops.closeHandle(waitHandle)
	event, err := ops.waitForSingleObject(waitHandle, windows.INFINITE)
	if err != nil {
		return -1, fmt.Errorf("WaitForSingleObject: %w", err)
	}
	if event != windows.WAIT_OBJECT_0 {
		return -1, fmt.Errorf("WaitForSingleObject: unexpected event %d", event)
	}
	var exitCode uint32
	if err := ops.getExitCodeProcess(waitHandle, &exitCode); err != nil {
		return -1, fmt.Errorf("GetExitCodeProcess: %w", err)
	}
	return int(exitCode), nil
}

func duplicateProcessHandle(handle windows.Handle) (windows.Handle, error) {
	currentProcess, err := windows.GetCurrentProcess()
	if err != nil {
		return 0, fmt.Errorf("GetCurrentProcess: %w", err)
	}
	var duplicate windows.Handle
	if err := windows.DuplicateHandle(
		currentProcess,
		handle,
		currentProcess,
		&duplicate,
		0,
		false,
		windows.DUPLICATE_SAME_ACCESS,
	); err != nil {
		return 0, fmt.Errorf("DuplicateHandle: %w", err)
	}
	return duplicate, nil
}

type helperJobOwner interface {
	Assign(windows.Handle) error
	Close() error
}

type suspendedHelper struct {
	process            windows.Handle
	thread             windows.Handle
	pid                uint32
	binaryPath         string
	mainBinaryFallback bool
	tokenSource        string
}

type windowsSpawnOps struct {
	resolveExecutable func() (ResolvedHelperExecutable, error)
	createSuspended   func(HelperKey, ResolvedHelperExecutable) (*suspendedHelper, error)
	resumeThread      func(windows.Handle) (uint32, error)
	terminateProcess  func(windows.Handle, uint32) error
	closeHandle       func(windows.Handle) error
	closeStarting     func()
}

// windowsHelperSpawner is the single owner of the helper Job Object. Its
// mutex covers the complete create-suspended -> assign -> resume transaction
// and Job close, so no helper can escape during lifecycle shutdown.
type windowsHelperSpawner struct {
	mu              sync.Mutex
	job             helperJobOwner
	closing         bool
	ops             windowsSpawnOps
	fallbackWarning helperFallbackWarningOwner
}

func newWindowsHelperSpawner() (*windowsHelperSpawner, error) {
	job, err := newHelperJob()
	if err != nil {
		return nil, err
	}
	return newWindowsHelperSpawnerWithJob(job, windowsSpawnOps{}), nil
}

func newWindowsHelperSpawnerWithJob(job helperJobOwner, ops windowsSpawnOps) *windowsHelperSpawner {
	if ops.resolveExecutable == nil {
		ops.resolveExecutable = userHelperExePath
	}
	if ops.createSuspended == nil {
		ops.createSuspended = createHelperSuspended
	}
	if ops.resumeThread == nil {
		ops.resumeThread = windows.ResumeThread
	}
	if ops.terminateProcess == nil {
		ops.terminateProcess = windows.TerminateProcess
	}
	if ops.closeHandle == nil {
		ops.closeHandle = windows.CloseHandle
	}
	return &windowsHelperSpawner{job: job, ops: ops}
}

func (s *windowsHelperSpawner) Spawn(key HelperKey) (helperProcess, error) {
	if s == nil {
		return nil, fmt.Errorf("Windows helper spawner is closed")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || s.job == nil {
		return nil, fmt.Errorf("Windows helper spawner is closed")
	}

	resolvedExe, err := s.ops.resolveExecutable()
	if err != nil {
		return nil, fmt.Errorf("resolve helper executable: %w", err)
	}
	s.fallbackWarning.WarnIfFallback(resolvedExe)

	pending, err := s.ops.createSuspended(key, resolvedExe)
	if err != nil {
		return nil, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = s.ops.terminateProcess(pending.process, 1)
			_ = s.ops.closeHandle(pending.thread)
			_ = s.ops.closeHandle(pending.process)
		}
	}()
	jobOwned := true
	if err := s.job.Assign(pending.process); err != nil {
		// On an RD Session Host the helper is created inside the session's own
		// job, which forbids joining a second job, so AssignProcessToJobObject is
		// denied. The old fail-closed behavior (return here) left EVERY RDS
		// session with no helper at all and looped forever — see #2536, found on
		// a real RDS host. Proceed without job membership instead: the helper is
		// still tracked and terminated through its process handle on logoff,
		// shutdown, and reconcile. Only OS-enforced KILL_ON_JOB_CLOSE cleanup
		// after an agent *crash* is lost, and the single-instance guard plus
		// reconcile reclaim such orphans on the next start.
		jobOwned = false
		log.Warn("helper not assigned to job object; using handle-based ownership only",
			"helperKey", key.String(), "pid", pending.pid, "error", err.Error())
	}
	if _, err := s.ops.resumeThread(pending.thread); err != nil {
		return nil, fmt.Errorf("resume helper: %w", err)
	}
	_ = s.ops.closeHandle(pending.thread)
	cleanup = false

	helper := &SpawnedHelper{
		PID:                pending.pid,
		Handle:             pending.process,
		BinaryPath:         resolvedExe.Path,
		CommandMode:        "user-helper",
		Role:               key.Role,
		WindowsSessionID:   key.WindowsSessionID,
		MainBinaryFallback: resolvedExe.MainBinaryFallback,
	}
	log.Info("spawned user helper in session",
		"pid", helper.PID,
		"binaryPath", helper.BinaryPath,
		"commandMode", helper.CommandMode,
		"role", helper.Role,
		"windowsSessionId", helper.WindowsSessionID,
		"mainBinaryFallback", helper.MainBinaryFallback,
		"jobOwned", jobOwned,
	)
	return helper, nil
}

func (s *windowsHelperSpawner) Close() error {
	if s == nil {
		return nil
	}
	if s.ops.closeStarting != nil {
		s.ops.closeStarting()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return nil
	}
	s.closing = true
	if s.job == nil {
		return nil
	}
	return s.job.Close()
}

// createHelperSuspended creates the helper process for key without letting its
// primary thread run. The role selects the token privilege level, so an
// unrecognized role must never reach a spawn call: the previous permissive
// default sent anything that was not exactly "user" down the SYSTEM-token
// branch, so an empty or misspelled role silently escalated.
func createHelperSuspended(key HelperKey, resolvedExe ResolvedHelperExecutable) (*suspendedHelper, error) {
	if !helperRoleSpawnable(key.Role) {
		return nil, fmt.Errorf("refusing to spawn helper for non-lifecycle role %q", key.Role)
	}
	switch key.Role {
	case ipc.HelperRoleUser:
		return createUserHelperSuspended(key.WindowsSessionID, resolvedExe)
	case ipc.HelperRoleSystem:
		return createSystemHelperSuspended(key.WindowsSessionID, resolvedExe)
	default:
		return nil, fmt.Errorf("role %q passed helperRoleSpawnable but has no spawn path", key.Role)
	}
}

// createSystemHelperSuspended creates the SYSTEM-token helper without allowing
// its primary thread to run. The caller must assign it to the Job Object before
// resuming it.
func createSystemHelperSuspended(sessionID uint32, resolvedExe ResolvedHelperExecutable) (*suspendedHelper, error) {
	var processToken windows.Token
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		return nil, fmt.Errorf("GetCurrentProcess: %w", err)
	}
	if err := windows.OpenProcessToken(proc, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &processToken); err != nil {
		return nil, fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer processToken.Close()

	var dupToken windows.Token
	if err := windows.DuplicateTokenEx(
		processToken,
		windows.MAXIMUM_ALLOWED,
		nil,
		windows.SecurityImpersonation,
		windows.TokenPrimary,
		&dupToken,
	); err != nil {
		return nil, fmt.Errorf("DuplicateTokenEx: %w", err)
	}
	defer dupToken.Close()

	if err := windows.SetTokenInformation(
		dupToken,
		windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sessionID)),
		uint32(unsafe.Sizeof(sessionID)),
	); err != nil {
		return nil, fmt.Errorf("SetTokenInformation(TokenSessionId=%d): %w", sessionID, err)
	}

	cmdLine, err := windows.UTF16PtrFromString(buildUserHelperCmdLine(resolvedExe.Path, ipc.HelperRoleSystem))
	if err != nil {
		return nil, fmt.Errorf("UTF16PtrFromString: %w", err)
	}
	desktop, err := windows.UTF16PtrFromString(`winsta0\Default`)
	if err != nil {
		return nil, fmt.Errorf("UTF16PtrFromString desktop: %w", err)
	}
	si := windows.StartupInfo{
		Cb:      uint32(unsafe.Sizeof(windows.StartupInfo{})),
		Desktop: desktop,
	}
	var pi windows.ProcessInformation
	if err := createSuspendedHelperProcess(dupToken, cmdLine, nil, &si, &pi); err != nil {
		return nil, fmt.Errorf("CreateProcessAsUser(session=%d): %w", sessionID, err)
	}
	return &suspendedHelper{
		process:            pi.Process,
		thread:             pi.Thread,
		pid:                pi.ProcessId,
		binaryPath:         resolvedExe.Path,
		mainBinaryFallback: resolvedExe.MainBinaryFallback,
		tokenSource:        "system",
	}, nil
}

// createSuspendedHelperProcess launches the helper as token in winsta0\Default,
// suspended, first asking it to break away from any job it would otherwise
// inherit (CREATE_BREAKAWAY_FROM_JOB) so it can be assigned to the agent's Job
// Object. Breakaway only affects the CALLING process's job, so on an RD Session
// Host — where the helper joins the target session's own job — it may not free
// the helper; the caller's job assignment is therefore best-effort (see #2536).
//
// If breakaway is refused (the calling process's job lacks
// JOB_OBJECT_LIMIT_BREAKAWAY_OK, so CreateProcessAsUser returns
// ERROR_ACCESS_DENIED), retry without the flag so we never fail to create the
// process just because breakaway was unavailable.
func createSuspendedHelperProcess(token windows.Token, cmdLine *uint16, envBlock *uint16, si *windows.StartupInfo, pi *windows.ProcessInformation) error {
	const base = uint32(windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW | windows.CREATE_UNICODE_ENVIRONMENT)
	err := windows.CreateProcessAsUser(token, nil, cmdLine, nil, nil, false,
		base|windows.CREATE_BREAKAWAY_FROM_JOB, envBlock, nil, si, pi)
	if err == nil {
		return nil
	}
	return windows.CreateProcessAsUser(token, nil, cmdLine, nil, nil, false,
		base, envBlock, nil, si, pi)
}

// createUserHelperSuspended creates the interactive-user helper without
// allowing its primary thread to run. The caller assigns it to the Job Object
// before resume.
func createUserHelperSuspended(sessionID uint32, resolvedExe ResolvedHelperExecutable) (*suspendedHelper, error) {
	dupToken, envBlock, method, err := acquireUserToken(sessionID)
	if err != nil {
		return nil, fmt.Errorf("acquire user token(session=%d): %w", sessionID, err)
	}
	defer dupToken.Close()
	if envBlock != nil {
		defer windows.DestroyEnvironmentBlock(envBlock)
	}

	cmdLine, err := windows.UTF16PtrFromString(buildUserHelperCmdLine(resolvedExe.Path, ipc.HelperRoleUser))
	if err != nil {
		return nil, fmt.Errorf("UTF16PtrFromString: %w", err)
	}
	desktop, err := windows.UTF16PtrFromString(`winsta0\Default`)
	if err != nil {
		return nil, fmt.Errorf("UTF16PtrFromString desktop: %w", err)
	}
	si := windows.StartupInfo{
		Cb:      uint32(unsafe.Sizeof(windows.StartupInfo{})),
		Desktop: desktop,
	}
	var pi windows.ProcessInformation
	if err := createSuspendedHelperProcess(dupToken, cmdLine, envBlock, &si, &pi); err != nil {
		return nil, fmt.Errorf("CreateProcessAsUser(session=%d, role=user): %w", sessionID, err)
	}
	return &suspendedHelper{
		process:            pi.Process,
		thread:             pi.Thread,
		pid:                pi.ProcessId,
		binaryPath:         resolvedExe.Path,
		mainBinaryFallback: resolvedExe.MainBinaryFallback,
		tokenSource:        method,
	}, nil
}

// SpawnHelperInSession is retained for compatibility with older callers. It
// creates a private one-process Job Object and transfers that spawner to the
// returned helper so Close releases the Job after the process exits.
func SpawnHelperInSession(sessionID uint32) (*SpawnedHelper, error) {
	return spawnStandaloneHelper(HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleSystem})
}

// SpawnUserHelperInSession is the user-token counterpart to
// SpawnHelperInSession.
func SpawnUserHelperInSession(sessionID uint32) (*SpawnedHelper, error) {
	return spawnStandaloneHelper(HelperKey{WindowsSessionID: sessionID, Role: ipc.HelperRoleUser})
}

func spawnStandaloneHelper(key HelperKey) (*SpawnedHelper, error) {
	spawner, err := newWindowsHelperSpawner()
	if err != nil {
		return nil, err
	}
	process, err := spawner.Spawn(key)
	if err != nil {
		_ = spawner.Close()
		return nil, err
	}
	helper := process.(*SpawnedHelper)
	waitHandle, err := duplicateProcessHandle(helper.Handle)
	if err != nil {
		_ = helper.Terminate()
		_ = helper.Close()
		_ = spawner.Close()
		return nil, fmt.Errorf("retain standalone helper Job ownership: %w", err)
	}
	helper.standaloneOwner = spawner
	go reapStandaloneHelper(waitHandle, spawner)
	return helper, nil
}

func reapStandaloneHelper(waitHandle windows.Handle, spawner *windowsHelperSpawner) {
	reapStandaloneHelperWithOps(waitHandle, spawner, defaultSpawnedHelperOps())
}

const (
	standaloneReaperInitialBackoff = 100 * time.Millisecond
	standaloneReaperMaxBackoff     = 5 * time.Second
)

func reapStandaloneHelperWithOps(waitHandle windows.Handle, spawner *windowsHelperSpawner, ops *spawnedHelperOps) {
	backoff := standaloneReaperInitialBackoff
	attempt := 0
	for {
		event, err := ops.waitForSingleObject(waitHandle, windows.INFINITE)
		if err == nil && event == windows.WAIT_OBJECT_0 {
			_ = ops.closeHandle(waitHandle)
			_ = spawner.Close()
			return
		}

		attempt++
		if attempt == 1 || attempt%12 == 0 {
			log.Warn("standalone helper wait did not confirm process exit; retaining Job ownership",
				"attempt", attempt,
				"event", event,
				"error", err,
			)
		}
		ops.sleep(backoff)
		if backoff < standaloneReaperMaxBackoff {
			backoff *= 2
			if backoff > standaloneReaperMaxBackoff {
				backoff = standaloneReaperMaxBackoff
			}
		}
	}
}
