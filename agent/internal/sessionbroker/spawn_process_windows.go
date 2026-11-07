//go:build windows

package sessionbroker

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnProcessInSession launches an arbitrary binary in the specified
// Windows session as the signed-in user, using the user token strategies of
// AcquireInteractiveUserToken. It never falls back to SYSTEM: with nobody
// signed in it returns ErrNoInteractiveUser and launches nothing (#10379).
//
// Uses cmd.exe as a wrapper because CreateProcessAsUser returns
// "Access is denied" for Tauri binaries — likely SmartScreen/WDAC.
func SpawnProcessInSession(binaryPath string, sessionID uint32) error {
	return SpawnProcessInSessionWithArgs(binaryPath, nil, sessionID)
}

// SpawnProcessInSessionWithArgs launches a binary plus args in the specified Windows session.
func SpawnProcessInSessionWithArgs(binaryPath string, args []string, sessionID uint32) error {
	// #6872: cmd.exe always exists, so CreateProcessAsUser(cmd.exe /c start
	// "" "<binary>") succeeds even when <binary> does not — the log then
	// claims a spawn with cmd.exe's PID and the user gets a "Windows cannot
	// find" dialog. Check the target first.
	if _, statErr := os.Stat(binaryPath); statErr != nil {
		if os.IsNotExist(statErr) {
			return fmt.Errorf("%w: %s", ErrBinaryMissing, binaryPath)
		}
		return fmt.Errorf("stat spawn target %s: %w", binaryPath, statErr)
	}

	// #10379: a user token or nothing. The SYSTEM fallback launched Breeze
	// Assist into the logon-screen session, where it exits 101 and the
	// watcher crash-looped.
	dupToken, envBlock, identity, err := AcquireInteractiveUserToken(sessionID)
	if err != nil {
		return err
	}
	defer dupToken.Close()
	if envBlock != nil {
		defer windows.DestroyEnvironmentBlock(envBlock)
	}

	quoted := append([]string{fmt.Sprintf(`"%s"`, binaryPath)}, quoteWindowsArgs(args)...)
	command := strings.Join(quoted, " ")

	// Build command: cmd.exe /c start "" "path\to\binary.exe" [args...]
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
		fmt.Sprintf(`"%s" /c start "" %s`, cmdExe, command),
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
		windows.StringToUTF16Ptr(filepath.Dir(binaryPath)),
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

func quoteWindowsArgs(args []string) []string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		// 1. Escape cmd.exe metacharacters with ^ (must come first so the ^
		//    we insert isn't itself re-escaped).
		var buf strings.Builder
		for i := 0; i < len(arg); i++ {
			switch arg[i] {
			case '&', '|', '<', '>', '^', '(', ')', '%':
				buf.WriteByte('^')
			}
			buf.WriteByte(arg[i])
		}
		escaped := buf.String()

		// 2. MSVCRT convention: backslashes immediately before a double-quote
		//    must be doubled, then the quote itself is escaped with a backslash.
		var out strings.Builder
		for i := 0; i < len(escaped); i++ {
			if escaped[i] == '"' {
				// Count preceding backslashes in the source string
				nbs := 0
				for j := i - 1; j >= 0 && escaped[j] == '\\'; j-- {
					nbs++
				}
				// Double existing backslashes before the quote
				for k := 0; k < nbs; k++ {
					out.WriteByte('\\')
				}
				out.WriteString(`\"`)
			} else {
				out.WriteByte(escaped[i])
			}
		}

		// 3. Double trailing backslashes before the wrapping close-quote,
		//    otherwise they would escape the closing " (e.g. C:\path\ → "C:\path\\").
		result := out.String()
		nbs := 0
		for i := len(result) - 1; i >= 0 && result[i] == '\\'; i-- {
			nbs++
		}
		for k := 0; k < nbs; k++ {
			out.WriteByte('\\')
		}

		quoted = append(quoted, fmt.Sprintf(`"%s"`, out.String()))
	}
	return quoted
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
