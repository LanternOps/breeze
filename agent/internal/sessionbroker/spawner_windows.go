//go:build windows

package sessionbroker

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnHelperInSession launches a user-helper process as SYSTEM in the
// specified Windows session. The helper inherits our SYSTEM token with the
// session ID overridden, giving it full desktop access (Default, Winlogon,
// Screensaver) in the target session.
func SpawnHelperInSession(sessionID uint32) error {
	// 1. Open our own process token (SYSTEM).
	var processToken windows.Token
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		return fmt.Errorf("GetCurrentProcess: %w", err)
	}
	err = windows.OpenProcessToken(proc, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &processToken)
	if err != nil {
		return fmt.Errorf("OpenProcessToken: %w", err)
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
		return fmt.Errorf("DuplicateTokenEx: %w", err)
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
		return fmt.Errorf("SetTokenInformation(TokenSessionId=%d): %w", sessionID, err)
	}

	// 4. Build the command line: same binary, "user-helper" subcommand.
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	cmdLine, err := windows.UTF16PtrFromString(fmt.Sprintf(`"%s" user-helper`, exePath))
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString: %w", err)
	}

	// 5. Target the interactive window station + default desktop.
	desktop, err := windows.UTF16PtrFromString(`winsta0\Default`)
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString desktop: %w", err)
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
		return fmt.Errorf("CreateProcessAsUser(session=%d): %w", sessionID, err)
	}

	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)

	log.Info("spawned user helper in session",
		"sessionId", sessionID,
		"role", "system",
		"pid", pi.ProcessId,
		"exe", exePath,
	)
	return nil
}

// SpawnUserHelperInSession launches a user-helper process using the logged-in
// user's token in the specified Windows session. Tries WTSQueryUserToken first,
// falls back to explorer.exe token theft for Azure AD sessions.
// This helper runs as the interactive user, enabling run_as_user script
// execution and launching the Breeze Helper Tauri app.
func SpawnUserHelperInSession(sessionID uint32) error {
	// Try WTSQueryUserToken first, fall back to explorer.exe token.
	dupToken, envBlock, method, err := acquireUserToken(sessionID)
	if err != nil {
		return fmt.Errorf("acquire user token(session=%d): %w", sessionID, err)
	}
	defer dupToken.Close()
	if envBlock != nil {
		defer windows.DestroyEnvironmentBlock(envBlock)
	}

	// Build command line with --role user flag.
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	cmdLine, err := windows.UTF16PtrFromString(fmt.Sprintf(`"%s" user-helper --role user`, exePath))
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString: %w", err)
	}

	desktop, err := windows.UTF16PtrFromString(`winsta0\Default`)
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString desktop: %w", err)
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
		return fmt.Errorf("CreateProcessAsUser(session=%d, role=user): %w", sessionID, err)
	}

	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)

	log.Info("spawned user-token helper in session",
		"sessionId", sessionID,
		"role", "user",
		"pid", pi.ProcessId,
		"exe", exePath,
		"tokenSource", method,
	)
	return nil
}
