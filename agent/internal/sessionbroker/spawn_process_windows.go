//go:build windows

package sessionbroker

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnProcessInSession launches an arbitrary binary in the specified
// Windows session. Uses cmd.exe as a wrapper because CreateProcessAsUser
// and CreateProcessWithTokenW both return "Access is denied" for Tauri
// binaries (even with asInvoker manifest) — likely due to Windows
// SmartScreen/WDAC restrictions on programmatic launches.
//
// The cmd.exe wrapper works because cmd.exe is a trusted system binary
// that can then launch the target via "start".
func SpawnProcessInSession(binaryPath string, sessionID uint32) error {
	// Get SYSTEM token and override session ID (same pattern as SpawnHelperInSession).
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

	var dupToken windows.Token
	err = windows.DuplicateTokenEx(
		processToken,
		windows.MAXIMUM_ALLOWED,
		nil,
		windows.SecurityDelegation,
		windows.TokenPrimary,
		&dupToken,
	)
	if err != nil {
		return fmt.Errorf("DuplicateTokenEx: %w", err)
	}
	defer dupToken.Close()

	err = windows.SetTokenInformation(
		dupToken,
		windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sessionID)),
		uint32(unsafe.Sizeof(sessionID)),
	)
	if err != nil {
		return fmt.Errorf("SetTokenInformation(session=%d): %w", sessionID, err)
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
		nil,
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
	)
	return nil
}
