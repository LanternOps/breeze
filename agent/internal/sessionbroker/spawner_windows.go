//go:build windows

package sessionbroker

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnedHelper describes a helper process after a successful spawn. It
// contains the PID and a duplicated process handle so callers can wait for
// the process to exit and inspect its exit code. Close() must be called to
// release the handle.
type SpawnedHelper struct {
	PID    uint32
	Handle windows.Handle
}

// Close releases the duplicated process handle. Safe to call more than once.
func (s *SpawnedHelper) Close() {
	if s == nil || s.Handle == 0 {
		return
	}
	_ = windows.CloseHandle(s.Handle)
	s.Handle = 0
}

// Wait blocks until the spawned helper process exits and returns its exit
// code. Returns -1 + error on failure. The process handle is released
// automatically after Wait returns so callers do not need to call Close
// in the normal path.
func (s *SpawnedHelper) Wait() (int, error) {
	if s == nil || s.Handle == 0 {
		return -1, fmt.Errorf("SpawnedHelper: no handle")
	}
	defer s.Close()
	event, err := windows.WaitForSingleObject(s.Handle, windows.INFINITE)
	if err != nil {
		return -1, fmt.Errorf("WaitForSingleObject: %w", err)
	}
	if event != windows.WAIT_OBJECT_0 {
		return -1, fmt.Errorf("WaitForSingleObject: unexpected event %d", event)
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(s.Handle, &exitCode); err != nil {
		return -1, fmt.Errorf("GetExitCodeProcess: %w", err)
	}
	return int(exitCode), nil
}

// SpawnHelperInSession launches a user-helper process as SYSTEM in the
// specified Windows session. Returns a SpawnedHelper describing the child
// process, or nil + an error on failure. The caller is responsible for
// closing the returned handle.
func SpawnHelperInSession(sessionID uint32) (*SpawnedHelper, error) {
	// 1. Open our own process token (SYSTEM).
	var processToken windows.Token
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		return nil, fmt.Errorf("GetCurrentProcess: %w", err)
	}
	err = windows.OpenProcessToken(proc, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &processToken)
	if err != nil {
		return nil, fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer processToken.Close()

	// 2. Duplicate as a primary token we can modify.
	// SecurityImpersonation is sufficient for local DXGI desktop capture;
	// SecurityDelegation is only needed for credential delegation to remote
	// machines, which the helper never performs.
	var dupToken windows.Token
	err = windows.DuplicateTokenEx(
		processToken,
		windows.MAXIMUM_ALLOWED,
		nil, // default security attributes
		windows.SecurityImpersonation,
		windows.TokenPrimary,
		&dupToken,
	)
	if err != nil {
		return nil, fmt.Errorf("DuplicateTokenEx: %w", err)
	}
	defer dupToken.Close()

	// 3. Set the session ID on the duplicate token.
	err = windows.SetTokenInformation(
		dupToken,
		windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sessionID)),
		uint32(unsafe.Sizeof(sessionID)),
	)
	if err != nil {
		return nil, fmt.Errorf("SetTokenInformation(TokenSessionId=%d): %w", sessionID, err)
	}

	// 4. Build the command line: same binary, "user-helper" subcommand.
	exePath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("os.Executable: %w", err)
	}
	cmdLine, err := windows.UTF16PtrFromString(fmt.Sprintf(`"%s" user-helper`, exePath))
	if err != nil {
		return nil, fmt.Errorf("UTF16PtrFromString: %w", err)
	}

	// 5. Target the interactive window station + default desktop.
	desktop, err := windows.UTF16PtrFromString(`winsta0\Default`)
	if err != nil {
		return nil, fmt.Errorf("UTF16PtrFromString desktop: %w", err)
	}

	si := windows.StartupInfo{
		Cb:      uint32(unsafe.Sizeof(windows.StartupInfo{})),
		Desktop: desktop,
	}
	var pi windows.ProcessInformation

	// 6. Create the process.
	err = windows.CreateProcessAsUser(
		dupToken,
		nil,     // lpApplicationName (use cmdLine)
		cmdLine, // lpCommandLine
		nil,     // lpProcessAttributes
		nil,     // lpThreadAttributes
		false,   // bInheritHandles
		windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT,
		nil, // lpEnvironment (inherit)
		nil, // lpCurrentDirectory (inherit)
		&si,
		&pi,
	)
	if err != nil {
		return nil, fmt.Errorf("CreateProcessAsUser(session=%d): %w", sessionID, err)
	}

	// Release the thread handle (we don't need it). Keep the process handle
	// so the lifecycle manager can wait on it and read the exit code.
	windows.CloseHandle(pi.Thread)

	log.Info("spawned user helper in session",
		"sessionId", sessionID,
		"role", "system",
		"pid", pi.ProcessId,
		"exe", exePath,
	)
	return &SpawnedHelper{PID: pi.ProcessId, Handle: pi.Process}, nil
}

// SpawnUserHelperInSession launches a user-helper process using the logged-in
// user's token in the specified Windows session. Tries WTSQueryUserToken first,
// falls back to explorer.exe token theft for Azure AD sessions.
// This helper runs as the interactive user, enabling run_as_user script
// execution and launching the Breeze Helper Tauri app.
//
// Returns a SpawnedHelper describing the child process; the caller is
// responsible for closing the returned handle.
func SpawnUserHelperInSession(sessionID uint32) (*SpawnedHelper, error) {
	// Try WTSQueryUserToken first, fall back to explorer.exe token.
	dupToken, envBlock, method, err := acquireUserToken(sessionID)
	if err != nil {
		return nil, fmt.Errorf("acquire user token(session=%d): %w", sessionID, err)
	}
	defer dupToken.Close()
	if envBlock != nil {
		defer windows.DestroyEnvironmentBlock(envBlock)
	}

	// Build command line with --role user flag.
	exePath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("os.Executable: %w", err)
	}
	cmdLine, err := windows.UTF16PtrFromString(fmt.Sprintf(`"%s" user-helper --role user`, exePath))
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

	if err := windows.CreateProcessAsUser(
		dupToken,
		nil,
		cmdLine,
		nil,
		nil,
		false,
		windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT,
		envBlock,
		nil,
		&si,
		&pi,
	); err != nil {
		return nil, fmt.Errorf("CreateProcessAsUser(session=%d, role=user): %w", sessionID, err)
	}

	windows.CloseHandle(pi.Thread)

	log.Info("spawned user-token helper in session",
		"sessionId", sessionID,
		"role", "user",
		"pid", pi.ProcessId,
		"exe", exePath,
		"tokenSource", method,
	)
	return &SpawnedHelper{PID: pi.ProcessId, Handle: pi.Process}, nil
}
