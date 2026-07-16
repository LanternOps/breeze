//go:build windows

package pamactuator

import (
	"context"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// DiagLaunch is a DIAGNOSTIC-ONLY entrypoint (used by cmd/pamlaunchtest) that
// exercises the real winTokenLauncher.Launch Win32 sequence on a Windows VM,
// decoupled from the ETW → user-helper dialog → PAM-rule chain. It lets the raw
// LogonUser → SetTokenInformation → desktop-DACL grant → CreateProcessAsUser
// path be validated (and session placement observed) in isolation. NOT used by
// any production code path.
func DiagLaunch(username, password, targetPath, commandLine string, sessionID uint32) (uint32, string, error) {
	out := (winTokenLauncher{}).Launch(context.Background(), launchParams{
		Username:    username,
		Password:    password,
		TargetPath:  targetPath,
		CommandLine: commandLine,
		SessionID:   sessionID,
	})
	return out.PID, out.Reason, out.Err
}

// DiagLaunchAsSessionUser is a DIAGNOSTIC control. It launches targetPath in the
// given session using that session's OWN interactive token (WTSQueryUserToken),
// deliberately bypassing LogonUser + session-stamp + desktop-grant. If this
// renders a normal (non-black) window while winTokenLauncher.Launch does not,
// the fault is isolated to the LogonUser-token/desktop-grant path — cross-session
// CreateProcessAsUser from SYSTEM itself works. NOT used by production code.
func DiagLaunchAsSessionUser(sessionID uint32, targetPath string) (uint32, error) {
	var tok windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &tok); err != nil {
		return 0, fmt.Errorf("WTSQueryUserToken: %w", err)
	}
	defer tok.Close()
	desktop, err := windows.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		return 0, err
	}
	app, err := windows.UTF16PtrFromString(targetPath)
	if err != nil {
		return 0, err
	}
	si := windows.StartupInfo{Desktop: desktop}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	if err := windows.CreateProcessAsUser(tok, app, nil, nil, nil, false,
		windows.CREATE_NEW_CONSOLE, nil, nil, &si, &pi); err != nil {
		return 0, fmt.Errorf("CreateProcessAsUser: %w", err)
	}
	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)
	return pi.ProcessId, nil
}

// DiagResolveSession is a DIAGNOSTIC entrypoint that runs the production #8
// session resolver (resolveSubjectSessionWith with the real Win32 lookups) for
// a subject username, returning the resolved session id and which precedence
// branch matched ("username_lookup" vs "console_fallback"). It lets the
// username→session mapping be validated on a multi-session (RDP) host without
// performing a launch. NOT used by production code.
func DiagResolveSession(subjectUsername string) (uint32, string, error) {
	return resolveSubjectSessionWith(
		Request{SubjectUsername: subjectUsername, ElevationRequestID: "diag"},
		sessionIDForUsername,
		activeConsoleSessionID,
	)
}
