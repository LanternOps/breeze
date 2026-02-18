//go:build windows

package userhelper

import "golang.org/x/sys/windows"

func currentWinSessionID() uint32 {
	var sessionID uint32
	err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &sessionID)
	if err != nil {
		return 0
	}
	return sessionID
}
