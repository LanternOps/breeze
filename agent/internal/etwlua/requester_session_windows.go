//go:build windows

package etwlua

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const maxProcessImagePath = 32768

func resolveRequesterSession() (username string, sessionID uint32, source string) {
	now := time.Now().UTC()
	consoleSessionID := windows.WTSGetActiveConsoleSessionId()

	trustedImagePath, err := trustedConsentImagePath()
	if err != nil {
		log.Debug("etwlua: failed to resolve trusted consent image path", "error", err.Error())
		return resolveRequesterSessionWith(nil, "", now, consoleSessionID, lookupSessionUser)
	}

	candidates, err := enumerateConsentProcesses()
	if err != nil {
		log.Debug("etwlua: consent process enumeration was incomplete", "error", err.Error())
	}
	return resolveRequesterSessionAfterEnumeration(
		candidates,
		err,
		trustedImagePath,
		now,
		consoleSessionID,
		lookupSessionUser,
	)
}

func trustedConsentImagePath() (string, error) {
	windowsDirectory, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(windowsDirectory, "System32", "consent.exe"), nil
}

func enumerateConsentProcesses() ([]consentProcessCandidate, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snapshot, &entry); err != nil {
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil, nil
		}
		return nil, fmt.Errorf("Process32First: %w", err)
	}

	var candidates []consentProcessCandidate
	for {
		if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), "consent.exe") {
			if candidate, ok := inspectConsentProcess(entry.ProcessID); ok {
				candidates = append(candidates, candidate)
			}
		}

		if err := windows.Process32Next(snapshot, &entry); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				return candidates, nil
			}
			return candidates, fmt.Errorf("Process32Next: %w", err)
		}
	}
}

func inspectConsentProcess(pid uint32) (consentProcessCandidate, bool) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return consentProcessCandidate{}, false
	}
	defer windows.CloseHandle(process)

	pathBuffer := make([]uint16, maxProcessImagePath)
	pathLength := uint32(len(pathBuffer))
	if err := windows.QueryFullProcessImageName(process, 0, &pathBuffer[0], &pathLength); err != nil {
		return consentProcessCandidate{}, false
	}

	var creationTime, exitTime, kernelTime, userTime windows.Filetime
	if err := windows.GetProcessTimes(process, &creationTime, &exitTime, &kernelTime, &userTime); err != nil {
		return consentProcessCandidate{}, false
	}

	var sessionID uint32
	if err := windows.ProcessIdToSessionId(pid, &sessionID); err != nil {
		return consentProcessCandidate{}, false
	}

	return consentProcessCandidate{
		PID:       pid,
		SessionID: sessionID,
		ImagePath: windows.UTF16ToString(pathBuffer[:pathLength]),
		StartedAt: time.Unix(0, creationTime.Nanoseconds()).UTC(),
	}, true
}

func lookupSessionUser(sessionID uint32) string {
	if !validInteractiveSessionID(sessionID) {
		return ""
	}

	var token windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &token); err != nil {
		return ""
	}
	defer token.Close()

	tokenUser, err := token.GetTokenUser()
	if err != nil {
		return ""
	}
	account, domain, _, err := tokenUser.User.Sid.LookupAccount("")
	if err != nil || account == "" {
		return ""
	}
	if domain == "" {
		return account
	}
	return domain + `\` + account
}
