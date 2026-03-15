//go:build windows

package sessionbroker

import (
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnProcessInSession launches an arbitrary binary in the specified
// Windows session as the logged-in user. Tries three strategies in order:
//  1. WTSQueryUserToken — standard API, fails on Azure AD cloud-only sessions
//  2. Explorer.exe token theft — find explorer.exe in the session and duplicate
//     its token; works for any login type including Azure AD
//  3. SYSTEM fallback — last resort, process runs as SYSTEM with session override
//
// Uses cmd.exe as a wrapper because CreateProcessAsUser returns
// "Access is denied" for Tauri binaries — likely SmartScreen/WDAC.
func SpawnProcessInSession(binaryPath string, sessionID uint32) error {
	dupToken, envBlock, identity, err := acquireUserToken(sessionID)
	if err != nil {
		return err
	}
	defer dupToken.Close()
	if envBlock != nil {
		defer windows.DestroyEnvironmentBlock(envBlock)
	}

	// Build command: cmd.exe /c start "" "path\to\binary.exe"
	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	cmdExe := sysRoot + `\System32\cmd.exe`

	appName, err := windows.UTF16PtrFromString(cmdExe)
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString appName: %w", err)
	}

	cmdLine, err := windows.UTF16PtrFromString(
		fmt.Sprintf(`"%s" /c start "" "%s"`, cmdExe, binaryPath),
	)
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString cmdLine: %w", err)
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

	err = windows.CreateProcessAsUser(
		dupToken,
		appName,
		cmdLine,
		nil,
		nil,
		false,
		windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT,
		envBlock,
		nil,
		&si,
		&pi,
	)
	if err != nil {
		return fmt.Errorf("CreateProcessAsUser(cmd.exe, session=%d, binary=%s): %w", sessionID, binaryPath, err)
	}

	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)

	log.Info("spawned process in session",
		"sessionId", sessionID,
		"pid", pi.ProcessId,
		"binary", binaryPath,
		"identity", identity,
	)
	return nil
}

// acquireUserToken tries to get a user-identity token for the session.
// Returns token, environment block, identity description, error.
func acquireUserToken(sessionID uint32) (windows.Token, *uint16, string, error) {
	// Strategy 1: WTSQueryUserToken (fast, works for local accounts)
	token, envBlock, _, err := getUserTokenViaWTS(sessionID)
	if err == nil {
		return token, envBlock, "user (WTS)", nil
	}
	wtsErr := err
	log.Debug("WTSQueryUserToken failed, trying explorer.exe token",
		"sessionId", sessionID, "error", err.Error())

	// Strategy 2: steal token from explorer.exe in the session
	token, envBlock, err = getUserTokenViaExplorer(sessionID)
	if err == nil {
		return token, envBlock, "user (explorer)", nil
	}
	log.Warn("all user token strategies failed, falling back to SYSTEM",
		"sessionId", sessionID,
		"wtsError", wtsErr.Error(),
		"explorerError", err.Error())

	// Strategy 3: SYSTEM fallback
	token, _, err = getSystemTokenForSession(sessionID)
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
