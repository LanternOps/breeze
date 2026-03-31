package helper

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const registryKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
const registryValue = "BreezeHelper"

func packageExtension() string { return ".msi" }

// installPackage runs the MSI installer silently.
// Exit code 3010 means success but reboot required — treated as success.
func installPackage(msiPath, _ string) error {
	cmd := exec.Command("msiexec", "/i", msiPath, "/qn", "/norestart")
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Exit code 3010 = ERROR_SUCCESS_REBOOT_REQUIRED
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 3010 {
			log.Info("MSI installed successfully (reboot required)", "msi", msiPath)
			return nil
		}
		return fmt.Errorf("msiexec: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	log.Info("MSI installed successfully", "msi", msiPath)
	return nil
}

func installAutoStart(binaryPath string) error {
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, registryKey, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("open registry key: %w", err)
	}
	defer key.Close()

	if err := key.SetStringValue(registryValue, binaryPath); err != nil {
		return fmt.Errorf("set registry value: %w", err)
	}

	log.Info("installed HKLM Run registry key", "value", registryValue)
	return nil
}

func isHelperRunning() bool {
	out, err := outputHelperCommand("tasklist", "/FI", "IMAGENAME eq breeze-helper.exe", "/NH")
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "breeze-helper.exe")
}

func stopHelper() error {
	return runHelperCommand("taskkill", "/F", "/IM", "breeze-helper.exe")
}

func removeAutoStart() error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, registryKey, registry.SET_VALUE)
	if err != nil {
		return nil // key doesn't exist
	}
	defer key.Close()
	if err := key.DeleteValue(registryValue); err != nil && err != registry.ErrNotExist {
		return fmt.Errorf("delete registry value: %w", err)
	}
	return nil
}

func stopByPID(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("invalid pid %d", pid)
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer windows.CloseHandle(handle)
	if err := windows.TerminateProcess(handle, 0); err != nil {
		return fmt.Errorf("TerminateProcess(%d): %w", pid, err)
	}
	return nil
}

func spawnWithConfig(binaryPath, sessionKey, configPath string) error {
	sessionNum, err := strconv.ParseUint(sessionKey, 10, 32)
	if err != nil {
		return fmt.Errorf("invalid session key %q: %w", sessionKey, err)
	}

	dupToken, envBlock, identity, err := acquireSpawnToken(uint32(sessionNum))
	if err != nil {
		return err
	}
	defer dupToken.Close()
	if envBlock != nil {
		defer windows.DestroyEnvironmentBlock(envBlock)
	}

	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	cmdExe := filepath.Join(sysRoot, "System32", "cmd.exe")

	appName, err := windows.UTF16PtrFromString(cmdExe)
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString appName: %w", err)
	}
	cmdLine, err := windows.UTF16PtrFromString(
		fmt.Sprintf(`"%s" /c start "" "%s" --config "%s"`, cmdExe, binaryPath, configPath),
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

	if err := windows.CreateProcessAsUser(
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
	); err != nil {
		return fmt.Errorf("CreateProcessAsUser(session=%d, binary=%s): %w", sessionNum, binaryPath, err)
	}

	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)

	log.Info("spawned assist in session",
		"sessionId", sessionNum,
		"pid", pi.ProcessId,
		"binary", binaryPath,
		"configPath", configPath,
		"identity", identity,
	)
	return nil
}

func acquireSpawnToken(sessionID uint32) (windows.Token, *uint16, string, error) {
	token, envBlock, err := getSpawnTokenViaWTS(sessionID)
	if err == nil {
		return token, envBlock, "user (WTS)", nil
	}
	wtsErr := err
	log.Debug("WTSQueryUserToken failed, trying explorer.exe token",
		"sessionId", sessionID, "error", err.Error())

	token, envBlock, err = getSpawnTokenViaExplorer(sessionID)
	if err == nil {
		return token, envBlock, "user (explorer)", nil
	}

	log.Warn("all user token strategies failed, falling back to SYSTEM",
		"sessionId", sessionID,
		"wtsError", wtsErr.Error(),
		"explorerError", err.Error(),
	)

	token, _, err = getSystemTokenForSpawn(sessionID)
	if err != nil {
		return 0, nil, "", err
	}
	return token, nil, "SYSTEM", nil
}

func getSpawnTokenViaWTS(sessionID uint32) (windows.Token, *uint16, error) {
	var userToken windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &userToken); err != nil {
		return 0, nil, fmt.Errorf("WTSQueryUserToken(session=%d): %w", sessionID, err)
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
		return 0, nil, fmt.Errorf("DuplicateTokenEx (user): %w", err)
	}

	var envBlock *uint16
	if err := windows.CreateEnvironmentBlock(&envBlock, dupToken, false); err != nil {
		dupToken.Close()
		return 0, nil, fmt.Errorf("CreateEnvironmentBlock: %w", err)
	}

	return dupToken, envBlock, nil
}

func getSpawnTokenViaExplorer(sessionID uint32) (windows.Token, *uint16, error) {
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
			var procSessionID uint32
			if err := windows.ProcessIdToSessionId(pe.ProcessID, &procSessionID); err == nil && procSessionID == sessionID {
				token, envBlock, err := tokenFromProcessID(pe.ProcessID)
				if err == nil {
					return token, envBlock, nil
				}
				log.Debug("failed to get token from explorer.exe", "pid", pe.ProcessID, "error", err.Error())
			}
		}

		if err := windows.Process32Next(snapshot, &pe); err != nil {
			break
		}
	}

	return 0, nil, fmt.Errorf("no explorer.exe found in session %d", sessionID)
}

func tokenFromProcessID(pid uint32) (windows.Token, *uint16, error) {
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

func getSystemTokenForSpawn(sessionID uint32) (windows.Token, bool, error) {
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		return 0, false, fmt.Errorf("GetCurrentProcess: %w", err)
	}

	var processToken windows.Token
	if err := windows.OpenProcessToken(proc, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &processToken); err != nil {
		return 0, false, fmt.Errorf("OpenProcessToken: %w", err)
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
		return 0, false, fmt.Errorf("DuplicateTokenEx: %w", err)
	}

	if err := windows.SetTokenInformation(
		dupToken,
		windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sessionID)),
		uint32(unsafe.Sizeof(sessionID)),
	); err != nil {
		dupToken.Close()
		return 0, false, fmt.Errorf("SetTokenInformation(TokenSessionId=%d): %w", sessionID, err)
	}

	return dupToken, true, nil
}
