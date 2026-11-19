//go:build windows

package sessionbroker

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// createProcessAsUser is windows.CreateProcessAsUser; a var so tests can
// capture the launch.
var createProcessAsUser = windows.CreateProcessAsUser

// SpawnProcessInSessionWithArgs launches binaryPath with args in the specified
// Windows session as the signed-in user, using the user token strategies of
// AcquireInteractiveUserToken, and returns the launched process's PID. It
// never falls back to SYSTEM: with nobody signed in it returns
// ErrNoInteractiveUser and launches nothing (#10379).
//
// The target is launched directly, not via cmd.exe /c start, so the returned
// PID is the target's own and the helper watcher can track it (#6923). The
// "Access is denied" that once motivated the cmd.exe wrapper (#220) was seen
// with a SYSTEM token; this path only ever launches with the user's token.
func SpawnProcessInSessionWithArgs(binaryPath string, args []string, sessionID uint32) (uint32, error) {
	process, pid, err := startProcessInSession(binaryPath, args, sessionID)
	if err != nil {
		return 0, err
	}
	_ = windows.CloseHandle(process)
	return pid, nil
}

// RunProcessInSessionWithArgs launches binaryPath like
// SpawnProcessInSessionWithArgs, then waits up to timeout for it to exit and
// returns its exit code. When the wait runs out it returns
// ErrProcessWaitTimeout and leaves the process running.
func RunProcessInSessionWithArgs(binaryPath string, args []string, sessionID uint32, timeout time.Duration) (uint32, error) {
	process, pid, err := startProcessInSession(binaryPath, args, sessionID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = windows.CloseHandle(process) }()

	// windows.INFINITE would wait forever; cap just below it.
	waitMs := uint32(windows.INFINITE - 1)
	if ms := timeout.Milliseconds(); ms < int64(waitMs) {
		waitMs = uint32(max(ms, 0))
	}
	event, err := windows.WaitForSingleObject(process, waitMs)
	if err != nil {
		return 0, fmt.Errorf("wait for %s (pid %d): %w", binaryPath, pid, err)
	}
	if event == uint32(windows.WAIT_TIMEOUT) {
		return 0, fmt.Errorf("%w: %s (pid %d) still running after %s", ErrProcessWaitTimeout, binaryPath, pid, timeout)
	}
	var code uint32
	if err := windows.GetExitCodeProcess(process, &code); err != nil {
		return 0, fmt.Errorf("exit code of %s (pid %d): %w", binaryPath, pid, err)
	}
	return code, nil
}

// directLaunchCommandLine is the lpCommandLine for launching binaryPath with
// args directly: argv[0] is the binary and every element is escaped by the
// CommandLineToArgvW rules, so the target receives each arg exactly. No
// cmd.exe parses the line, so its metacharacters (& | < > ^ % ( )) are
// ordinary characters and need no escaping.
func directLaunchCommandLine(binaryPath string, args []string) string {
	return windows.ComposeCommandLine(append([]string{binaryPath}, args...))
}

// startProcessInSession launches binaryPath with args as the signed-in user,
// on the session's interactive desktop. The caller closes the returned
// process handle.
func startProcessInSession(binaryPath string, args []string, sessionID uint32) (windows.Handle, uint32, error) {
	// #6872: report a missing target as ErrBinaryMissing before acquiring a
	// token, rather than as a launch failure.
	if _, statErr := os.Stat(binaryPath); statErr != nil {
		if os.IsNotExist(statErr) {
			return 0, 0, fmt.Errorf("%w: %s", ErrBinaryMissing, binaryPath)
		}
		return 0, 0, fmt.Errorf("stat spawn target %s: %w", binaryPath, statErr)
	}

	// #10379: a user token or nothing. The SYSTEM fallback launched Breeze
	// Assist into the logon-screen session, where it exits 101 and the
	// watcher crash-looped.
	dupToken, envBlock, identity, err := AcquireInteractiveUserToken(sessionID)
	if err != nil {
		return 0, 0, err
	}
	defer dupToken.Close()
	if envBlock != nil {
		defer windows.DestroyEnvironmentBlock(envBlock)
	}

	appName, err := windows.UTF16PtrFromString(binaryPath)
	if err != nil {
		return 0, 0, fmt.Errorf("UTF16PtrFromString appName: %w", err)
	}
	cmdLine, err := windows.UTF16PtrFromString(directLaunchCommandLine(binaryPath, args))
	if err != nil {
		return 0, 0, fmt.Errorf("UTF16PtrFromString cmdLine: %w", err)
	}
	workDir, err := windows.UTF16PtrFromString(filepath.Dir(binaryPath))
	if err != nil {
		return 0, 0, fmt.Errorf("UTF16PtrFromString workDir: %w", err)
	}
	desktop, err := windows.UTF16PtrFromString(`winsta0\Default`)
	if err != nil {
		return 0, 0, fmt.Errorf("UTF16PtrFromString desktop: %w", err)
	}

	si := windows.StartupInfo{
		Cb:      uint32(unsafe.Sizeof(windows.StartupInfo{})),
		Desktop: desktop,
	}
	var pi windows.ProcessInformation

	// CREATE_NO_WINDOW: the agent service has no console, and a console
	// target (taskkill) would otherwise open a console window on the user's
	// desktop. GUI targets ignore the flag.
	if err := createProcessAsUser(
		dupToken,
		appName,
		cmdLine,
		nil,
		nil,
		false,
		windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT,
		envBlock,
		workDir,
		&si,
		&pi,
	); err != nil {
		return 0, 0, fmt.Errorf("CreateProcessAsUser(session=%d, binary=%s): %w", sessionID, binaryPath, err)
	}
	_ = windows.CloseHandle(pi.Thread)

	log.Info("spawned process in session",
		"sessionId", sessionID,
		"pid", pi.ProcessId,
		"binary", binaryPath,
		"identity", identity,
	)
	return pi.Process, pi.ProcessId, nil
}

// userTokenStrategy is one way to obtain the signed-in user's primary token
// for a session. name is the identity description logged at spawn.
type userTokenStrategy struct {
	name    string
	acquire func(sessionID uint32) (windows.Token, *uint16, error)
}

// interactiveUserTokenStrategies are tried in order. A var so tests can
// stand in for the Win32 calls.
var interactiveUserTokenStrategies = []userTokenStrategy{
	// WTSQueryUserToken: fast, works for local and domain accounts.
	{name: "user (WTS)", acquire: func(sessionID uint32) (windows.Token, *uint16, error) {
		token, envBlock, _, err := getUserTokenViaWTS(sessionID)
		return token, envBlock, err
	}},
	// explorer.exe's token: works for Azure AD sessions, where
	// WTSQueryUserToken can fail.
	{name: "user (explorer)", acquire: getUserTokenViaExplorer},
}

// systemTokenForSession is the SYSTEM fallback of acquireUserToken. A var so
// tests can prove the user-only path never reaches it.
var systemTokenForSession = getSystemTokenForSession

// AcquireInteractiveUserToken returns a primary token and environment block
// for the user signed in to sessionID, and the identity description of the
// strategy that produced it. It never returns a SYSTEM token: when no strategy
// yields a user token (nobody is signed in to the session, or the user's
// shell has not started yet) it fails with ErrNoInteractiveUser, which callers
// treat as "wait for a user" (#10379). The caller closes the token and
// destroys a non-nil environment block.
func AcquireInteractiveUserToken(sessionID uint32) (windows.Token, *uint16, string, error) {
	var failures []string
	for _, s := range interactiveUserTokenStrategies {
		token, envBlock, err := s.acquire(sessionID)
		if err == nil {
			return token, envBlock, s.name, nil
		}
		log.Debug("user token strategy failed", "sessionId", sessionID, "strategy", s.name, "error", err.Error())
		failures = append(failures, s.name+": "+err.Error())
	}
	return 0, nil, "", fmt.Errorf("session %d: %w (%s)", sessionID, ErrNoInteractiveUser, strings.Join(failures, "; "))
}

// acquireUserToken tries to get a user-identity token for the session and
// falls back to the agent's SYSTEM token with the session overridden. Only
// the desktop helper spawner (spawner_windows.go) uses it; launches that must
// run as the user use AcquireInteractiveUserToken.
// Returns token, environment block, identity description, error.
func acquireUserToken(sessionID uint32) (windows.Token, *uint16, string, error) {
	token, envBlock, identity, err := AcquireInteractiveUserToken(sessionID)
	if err == nil {
		return token, envBlock, identity, nil
	}
	log.Warn("all user token strategies failed, falling back to SYSTEM",
		"sessionId", sessionID,
		"error", err.Error())

	token, _, err = systemTokenForSession(sessionID)
	if err != nil {
		return 0, nil, "", err
	}
	return token, nil, "SYSTEM", nil
}

// getUserTokenViaWTS obtains the logged-in user's token via WTSQueryUserToken.
func getUserTokenViaWTS(sessionID uint32) (windows.Token, *uint16, bool, error) {
	var userToken windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &userToken); err != nil {
		return 0, nil, false, fmt.Errorf("WTSQueryUserToken(session=%d): %w", sessionID, err)
	}
	defer userToken.Close()

	var dupToken windows.Token
	if err := windows.DuplicateTokenEx(
		userToken,
		windows.MAXIMUM_ALLOWED,
		nil,
		windows.SecurityImpersonation,
		windows.TokenPrimary,
		&dupToken,
	); err != nil {
		return 0, nil, false, fmt.Errorf("DuplicateTokenEx (user): %w", err)
	}

	var envBlock *uint16
	if err := windows.CreateEnvironmentBlock(&envBlock, dupToken, false); err != nil {
		dupToken.Close()
		return 0, nil, false, fmt.Errorf("CreateEnvironmentBlock: %w", err)
	}

	return dupToken, envBlock, true, nil
}

// getUserTokenViaExplorer finds explorer.exe running in the target session
// and duplicates its process token. This works for Azure AD sessions where
// WTSQueryUserToken fails.
func getUserTokenViaExplorer(sessionID uint32) (windows.Token, *uint16, error) {
	// Snapshot all processes
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))

	if err := windows.Process32First(snapshot, &pe); err != nil {
		return 0, nil, fmt.Errorf("Process32First: %w", err)
	}

	for {
		name := windows.UTF16ToString(pe.ExeFile[:])
		if strings.EqualFold(name, "explorer.exe") {
			// Check if this explorer.exe is in our target session
			var procSessionID uint32
			if err := windows.ProcessIdToSessionId(pe.ProcessID, &procSessionID); err == nil && procSessionID == sessionID {
				token, envBlock, err := tokenFromPID(pe.ProcessID)
				if err == nil {
					return token, envBlock, nil
				}
				log.Debug("failed to get token from explorer.exe",
					"pid", pe.ProcessID, "error", err.Error())
			}
		}

		if err := windows.Process32Next(snapshot, &pe); err != nil {
			break
		}
	}

	return 0, nil, fmt.Errorf("no explorer.exe found in session %d", sessionID)
}

// tokenFromPID opens a process, duplicates its token as a primary token,
// and creates an environment block.
func tokenFromPID(pid uint32) (windows.Token, *uint16, error) {
	proc, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION, false, pid)
	if err != nil {
		return 0, nil, fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer windows.CloseHandle(proc)

	var procToken windows.Token
	if err := windows.OpenProcessToken(proc, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &procToken); err != nil {
		return 0, nil, fmt.Errorf("OpenProcessToken(%d): %w", pid, err)
	}
	defer procToken.Close()

	var dupToken windows.Token
	if err := windows.DuplicateTokenEx(
		procToken,
		windows.MAXIMUM_ALLOWED,
		nil,
		windows.SecurityImpersonation,
		windows.TokenPrimary,
		&dupToken,
	); err != nil {
		return 0, nil, fmt.Errorf("DuplicateTokenEx(%d): %w", pid, err)
	}

	var envBlock *uint16
	if err := windows.CreateEnvironmentBlock(&envBlock, dupToken, false); err != nil {
		dupToken.Close()
		return 0, nil, fmt.Errorf("CreateEnvironmentBlock(%d): %w", pid, err)
	}

	return dupToken, envBlock, nil
}

// getSystemTokenForSession duplicates the current process (SYSTEM) token
// with the session ID overridden. Used as last-resort fallback.
func getSystemTokenForSession(sessionID uint32) (windows.Token, *uint16, error) {
	var processToken windows.Token
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		return 0, nil, fmt.Errorf("GetCurrentProcess: %w", err)
	}
	if err := windows.OpenProcessToken(proc, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &processToken); err != nil {
		return 0, nil, fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer processToken.Close()

	var dupToken windows.Token
	if err := windows.DuplicateTokenEx(
		processToken,
		windows.MAXIMUM_ALLOWED,
		nil,
		windows.SecurityDelegation,
		windows.TokenPrimary,
		&dupToken,
	); err != nil {
		return 0, nil, fmt.Errorf("DuplicateTokenEx: %w", err)
	}

	if err := windows.SetTokenInformation(
		dupToken,
		windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sessionID)),
		uint32(unsafe.Sizeof(sessionID)),
	); err != nil {
		dupToken.Close()
		return 0, nil, fmt.Errorf("SetTokenInformation(session=%d): %w", sessionID, err)
	}

	return dupToken, nil, nil
}
