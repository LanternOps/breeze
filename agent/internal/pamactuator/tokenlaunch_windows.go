//go:build windows

package pamactuator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// tokenLaunchActuator is the Path B implementation. Instead of typing
// credentials into consent.exe (windowsActuator), it launches the target
// executable elevated via LogonUser(~breeze_elev) → CreateProcessAsUser,
// running as ~breeze_elev on the requesting user's interactive desktop. The
// native consent.exe prompt is suppressed by the embedded windowsActuator's
// Dismiss (Escape) primitive — Path B reuses the deny path verbatim.
//
// The promote/demote of ~breeze_elev is the caller's responsibility
// (heartbeat.actuateElevation); this actuator only consumes the minted
// credential in the Request.
type tokenLaunchActuator struct {
	windowsActuator // inherit Dismiss (secure-desktop Escape)
	launcher        tokenLauncher
	// sessionResolver returns the interactive session id to place the launched
	// process into, given the actuation Request. Swappable for tests. It takes
	// the Request (rather than no args) so a future fix can resolve the
	// *requesting user's* session instead of the physical console — see the
	// "Session resolution" section of the VM validation doc. The default
	// (activeConsoleSessionID) currently ignores the argument.
	sessionResolver func(Request) (uint32, error)
	// suppress performs a best-effort dismissal of any pending consent.exe
	// before Trigger launches the target. Defaults to the embedded
	// windowsActuator's Dismiss (Escape consent.exe) — Path B reuses Path A's
	// deny primitive as its suppression step. Swappable for tests so the
	// suppress-then-launch ordering is unit-assertable. A failed or
	// "no_consent_window" suppress result is logged but MUST NOT abort the
	// launch: on the remote approve path consent.exe may already have timed
	// out, and the launch itself does not depend on it being gone.
	suppress func(context.Context) Result
}

func newTokenLaunchActuator() Actuator {
	a := &tokenLaunchActuator{
		launcher:        &winTokenLauncher{},
		sessionResolver: resolveSubjectSession,
	}
	a.suppress = a.windowsActuator.Dismiss
	return a
}

// launchParams is the resolved input to a single CreateProcessAsUser launch.
type launchParams struct {
	Username    string
	Password    string
	TargetPath  string
	CommandLine string
	SessionID   uint32
}

// launchOutcome reports the result of the raw launch. Reason is "" on success.
type launchOutcome struct {
	PID    uint32
	Reason string
	Err    error
}

// tokenLauncher performs the raw Win32 elevation launch. Isolated behind an
// interface so tokenLaunchActuator's orchestration is unit-testable with a
// fake; the concrete winTokenLauncher is validated on a Windows VM.
type tokenLauncher interface {
	Launch(ctx context.Context, p launchParams) launchOutcome
}

func (a *tokenLaunchActuator) Trigger(ctx context.Context, req Request) Result {
	if req.TargetPath == "" {
		return Result{Success: false, Reason: "empty_target",
			DetailMessage: "token_launch: no target executable in request"}
	}

	// Best-effort: suppress the pending consent.exe BEFORE launching, per the
	// design ("Dismiss() the pending consent.exe, THEN launch"). This must
	// never abort the launch — on the remote approve path consent.exe may
	// already have timed out, and the token-launch primitive does not depend
	// on it being gone. The caller already holds pamActuateMu, so no locking
	// is needed here.
	if a.suppress != nil {
		if res := a.suppress(ctx); !res.Success {
			slog.Warn("pamactuator: token_launch best-effort consent suppression did not succeed, launching anyway",
				"elevationRequestId", req.ElevationRequestID, "reason", res.Reason)
		}
	}

	sess, err := a.sessionResolver(req)
	if err != nil {
		return Result{Success: false, Reason: "session_lookup_failed",
			DetailMessage: "resolving interactive session: " + err.Error()}
	}

	out := a.launcher.Launch(ctx, launchParams{
		Username:    req.Username,
		Password:    req.Password,
		TargetPath:  req.TargetPath,
		CommandLine: req.CommandLine,
		SessionID:   sess,
	})
	if out.Reason != "" {
		msg := out.Reason
		if out.Err != nil {
			msg = out.Err.Error()
		}
		slog.Warn("pamactuator: token_launch failed",
			"elevationRequestId", req.ElevationRequestID, "reason", out.Reason)
		return Result{Success: false, Reason: out.Reason, DetailMessage: msg}
	}

	slog.Info("pamactuator: token_launch complete",
		"elevationRequestId", req.ElevationRequestID, "pid", out.PID)
	return Result{Success: true, Reason: "ok",
		DetailMessage: "target launched elevated via CreateProcessAsUser"}
}

// activeConsoleSessionID returns the session id of the physical console. It
// currently ignores the Request (the console session is used regardless of
// who requested elevation) — the signature carries Request so a future fix
// can resolve the *requesting user's* session instead; see the "Session
// resolution" section of the VM validation doc.
func activeConsoleSessionID(Request) (uint32, error) {
	id := windows.WTSGetActiveConsoleSessionId()
	if id == 0xFFFFFFFF {
		return 0, windows.ERROR_NO_SUCH_LOGON_SESSION
	}
	return id, nil
}

// resolveSubjectSession is the production sessionResolver for token_launch. It
// applies the precedence in resolveSubjectSessionWith (explicit ETW session →
// requesting user's live session by name → physical console) and logs which
// branch resolved the session, so a misplaced launch on a multi-session host is
// diagnosable from the agent log. Runs as SYSTEM (the agent), which
// WTSQueryUserToken/WTSEnumerateSessions require.
func resolveSubjectSession(req Request) (uint32, error) {
	id, source, err := resolveSubjectSessionWith(req, sessionIDForUsername, activeConsoleSessionID)
	if err != nil {
		slog.Warn("pamactuator: session resolution failed",
			"elevationRequestId", req.ElevationRequestID, "source", source, "error", err.Error())
		return 0, err
	}
	slog.Info("pamactuator: resolved target session",
		"elevationRequestId", req.ElevationRequestID, "session", id, "source", source,
		"subjectUsername", bareUsername(req.SubjectUsername))
	return id, nil
}

// sessionIDForUsername returns the id of the first Active interactive session
// whose logged-in user matches username (bare name, case-insensitive). ok is
// false when no active session matches — the caller then falls back to the
// console. Enumerates local sessions via WTSEnumerateSessions and reads each
// session's user via WTSQuerySessionInformation(WTSUserName).
func sessionIDForUsername(username string) (uint32, bool) {
	want := bareUsername(username)
	if want == "" {
		return 0, false
	}

	var infoPtr *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(windows.Handle(wtsCurrentServerHandle), 0, 1, &infoPtr, &count); err != nil {
		slog.Warn("pamactuator: WTSEnumerateSessions failed", "error", err.Error())
		return 0, false
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(infoPtr)))

	sessions := unsafe.Slice(infoPtr, count)
	for _, s := range sessions {
		if s.State != windows.WTSActive {
			continue // only sessions with a live, connected interactive desktop
		}
		if u := wtsSessionUsername(s.SessionID); u != "" && strings.EqualFold(u, want) {
			return s.SessionID, true
		}
	}
	return 0, false
}

// wtsSessionUsername returns the bare account name logged into sessionID, or ""
// if none/unknown. WTSUserName is not wrapped by x/sys/windows, so it is called
// through wtsapi32.dll directly (same LazyDLL pattern as the rest of this file).
func wtsSessionUsername(sessionID uint32) string {
	var buf *uint16
	var n uint32
	r, _, _ := procWTSQuerySessionInformationW.Call(
		uintptr(wtsCurrentServerHandle),
		uintptr(sessionID),
		uintptr(wtsUserName),
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&n)),
	)
	if r == 0 || buf == nil {
		return ""
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buf)))
	return windows.UTF16PtrToString(buf)
}

// Win32 constants not exported by x/sys/windows (or kept local so a compile
// doesn't hinge on their being exported by a given module version).
const (
	logon32LogonInteractive = 2
	logon32ProviderDefault  = 0

	// Rights needed to read and rewrite an object's DACL.
	readControlAccess = 0x00020000
	writeDACAccess    = 0x00040000

	// Non-inherited ACE — the winsta and desktop DACLs are edited directly, so
	// we don't rely on inheritance to reach the desktop from the window station.
	noInheritance = 0

	// WTS session-info query for the current server, WTSUserName info class.
	// WTSQuerySessionInformation/WTSUserName aren't wrapped by x/sys/windows.
	wtsCurrentServerHandle = 0
	wtsUserName            = 5 // WTS_INFO_CLASS.WTSUserName
)

var (
	advapi32Lazy   = windows.NewLazySystemDLL("advapi32.dll")
	procLogonUserW = advapi32Lazy.NewProc("LogonUserW")

	user32Lazy             = windows.NewLazySystemDLL("user32.dll")
	procOpenWindowStationW = user32Lazy.NewProc("OpenWindowStationW")
	procOpenDesktopW       = user32Lazy.NewProc("OpenDesktopW")
	procCloseWindowStation = user32Lazy.NewProc("CloseWindowStation")
	procCloseDesktop       = user32Lazy.NewProc("CloseDesktop")

	userenvLazy                 = windows.NewLazySystemDLL("userenv.dll")
	procLoadUserProfileW        = userenvLazy.NewProc("LoadUserProfileW")
	procUnloadUserProfile       = userenvLazy.NewProc("UnloadUserProfile")
	procCreateEnvironmentBlock  = userenvLazy.NewProc("CreateEnvironmentBlock")
	procDestroyEnvironmentBlock = userenvLazy.NewProc("DestroyEnvironmentBlock")

	wtsapi32Lazy                    = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSQuerySessionInformationW = wtsapi32Lazy.NewProc("WTSQuerySessionInformationW")
)

// profileInfo mirrors userenv.h PROFILEINFOW for LoadUserProfileW.
type profileInfo struct {
	Size        uint32
	Flags       uint32
	Username    *uint16
	ProfilePath *uint16
	DefaultPath *uint16
	ServerName  *uint16
	PolicyPath  *uint16
	Profile     windows.Handle
}

// piNoUI suppresses any profile-load UI (there is no interactive context here).
const piNoUI = 0x00000001

type winTokenLauncher struct{}

// sessionLaunchHelperFlag is the argv sentinel that tells a re-exec of this
// binary to run the in-session second stage (MaybeRunSessionLaunchHelper)
// instead of its normal startup. It is passed by spawnSessionHelper.
const sessionLaunchHelperFlag = "--pam-session-launch-helper"

// sessionLaunchParams / sessionLaunchResult are the stdin/stdout JSON contract
// between the session-0 stage (spawnSessionHelper) and the in-session helper
// (MaybeRunSessionLaunchHelper). Params (incl. the credential) travel on the
// helper's stdin pipe — never on its command line — and the result on stdout.
type sessionLaunchParams struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	TargetPath  string `json:"targetPath"`
	CommandLine string `json:"commandLine"`
	SessionID   uint32 `json:"sessionId"`
}

type sessionLaunchResult struct {
	PID    uint32 `json:"pid"`
	Reason string `json:"reason"`
	Err    string `json:"err,omitempty"`
}

// Launch performs the Path B elevation launch. It runs as SYSTEM in session 0
// (the agent service, or the SYSTEM scheduled task in the diagnostic harness),
// but the window-station/desktop DACL grant that makes the launched window
// paintable can only be done from *inside* the target session:
// OpenWindowStation/OpenDesktop resolve relative to the caller's session, and a
// session-0 process cannot name another session's WinSta0. Granting session 0's
// non-interactive WinSta0 is a no-op for the target-session render — the window
// appears but stays black/unpaintable (VM finding #2(b)).
//
// So Launch delegates the LogonUser → session-stamp → desktop-DACL grant →
// CreateProcessAsUser sequence to a SYSTEM helper spawned INTO the target
// session (spawnSessionHelper stamps this process's own SYSTEM token to the
// target session id). In that helper, winsta0\default resolves to the target
// session's live interactive desktop and SYSTEM holds WRITE_DAC, so the grant
// finally lands where it renders. See MaybeRunSessionLaunchHelper for the
// second stage.
//
// NOTE: the launched process still inherits the SYSTEM service's environment
// block (nil env). That is adequate to prove session placement + elevation +
// paint on the VM matrix; a follow-up should LoadUserProfile(~breeze_elev) +
// CreateEnvironmentBlock so the elevated app gets the account's profile env
// (APPDATA/USERPROFILE) — the finding ruled profile-loading out as the black
// window's cause, so it is deliberately kept out of this fix's change surface.
func (winTokenLauncher) Launch(_ context.Context, p launchParams) launchOutcome {
	return spawnSessionHelper(p)
}

// spawnSessionHelper is Launch's session-0 stage. It re-execs this binary as
// SYSTEM into p.SessionID with the session-launch-helper sentinel, hands the
// launch params to it over stdin, and relays the launch result the helper
// reports on stdout. It does NOT wait for the helper to exit — the helper
// outlives this call, holding the desktop grant for the launched process's UI
// lifetime.
func spawnSessionHelper(p launchParams) launchOutcome {
	exe, err := os.Executable()
	if err != nil {
		return launchOutcome{Reason: "session_helper_failed", Err: err}
	}

	// SYSTEM token stamped to the target session — the helper then runs as
	// SYSTEM *inside* that session, where its winsta0\default resolves to the
	// session's live interactive desktop (unreachable by name from session 0)
	// and SYSTEM holds WRITE_DAC to grant the launch token's logon SID.
	sysTok, err := duplicateSystemTokenForSession(p.SessionID)
	if err != nil {
		return launchOutcome{Reason: "session_helper_failed", Err: err}
	}
	defer sysTok.Close()

	sa := windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(sa))

	// stdin pipe: helper reads inR (params); this process writes inW.
	var inR, inW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, &sa, 0); err != nil {
		return launchOutcome{Reason: "session_helper_failed", Err: err}
	}
	// The parent-kept ends must NOT be inherited by the child.
	windows.SetHandleInformation(inW, windows.HANDLE_FLAG_INHERIT, 0)

	// stdout pipe: helper writes outW (result); this process reads outR.
	var outR, outW windows.Handle
	if err := windows.CreatePipe(&outR, &outW, &sa, 0); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return launchOutcome{Reason: "session_helper_failed", Err: err}
	}
	windows.SetHandleInformation(outR, windows.HANDLE_FLAG_INHERIT, 0)

	// Route the helper's stderr to NUL so nothing but the result JSON reaches
	// its stdout (stray stderr on stdout would corrupt the JSON we decode).
	nulPtr, _ := windows.UTF16PtrFromString("NUL")
	nul, err := windows.CreateFile(nulPtr, windows.GENERIC_WRITE,
		windows.FILE_SHARE_WRITE|windows.FILE_SHARE_READ, &sa, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		windows.CloseHandle(outW)
		return launchOutcome{Reason: "session_helper_failed", Err: err}
	}

	desktop, _ := windows.UTF16PtrFromString(`winsta0\default`)
	exePtr, _ := windows.UTF16PtrFromString(exe)
	cmdPtr, err := utf16MutablePtr(`"` + exe + `" ` + sessionLaunchHelperFlag)
	if err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		windows.CloseHandle(outW)
		windows.CloseHandle(nul)
		return launchOutcome{Reason: "session_helper_failed", Err: err}
	}
	si := windows.StartupInfo{
		Desktop:   desktop,
		Flags:     windows.STARTF_USESTDHANDLES,
		StdInput:  inR,
		StdOutput: outW,
		StdErr:    nul,
	}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	err = windows.CreateProcessAsUser(sysTok, exePtr, cmdPtr, nil, nil, true,
		windows.CREATE_NO_WINDOW, nil, nil, &si, &pi)
	// The child-side handles are duplicated into the child at creation; close
	// this process's copies regardless of success so the pipes have a single
	// writer/reader (else our reads never see EOF).
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)
	windows.CloseHandle(nul)
	if err != nil {
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return launchOutcome{Reason: "session_helper_failed", Err: err}
	}
	// Detach: the helper runs independently and outlives this call.
	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)

	// Send the params, then read the single result object the helper writes.
	inFile := os.NewFile(uintptr(inW), "pam-helper-stdin")
	outFile := os.NewFile(uintptr(outR), "pam-helper-stdout")
	defer outFile.Close()
	if err := json.NewEncoder(inFile).Encode(sessionLaunchParams{
		Username:    p.Username,
		Password:    p.Password,
		TargetPath:  p.TargetPath,
		CommandLine: p.CommandLine,
		SessionID:   p.SessionID,
	}); err != nil {
		inFile.Close()
		return launchOutcome{Reason: "session_helper_failed", Err: err}
	}
	inFile.Close() // EOF for the helper's stdin decode

	var res sessionLaunchResult
	if err := json.NewDecoder(outFile).Decode(&res); err != nil {
		return launchOutcome{Reason: "session_helper_failed",
			Err: fmt.Errorf("reading helper result: %w", err)}
	}
	out := launchOutcome{PID: res.PID, Reason: res.Reason}
	if res.Err != "" {
		out.Err = errors.New(res.Err)
	}
	return out
}

// MaybeRunSessionLaunchHelper runs Launch's in-session second stage and exits
// when this process was re-exec'd with the session-launch-helper sentinel;
// otherwise it returns immediately and normal startup proceeds. It MUST be
// called at the very top of main() (before flag parsing) in any binary that
// hosts winTokenLauncher — today the diagnostic harness (cmd/pamlaunchtest),
// and the agent before Path B ships to production.
//
// This process is SYSTEM inside the target session (spawnSessionHelper put it
// there), so inSessionLaunch's OpenWindowStation("winsta0")/OpenDesktop("default")
// resolve to the target session's live interactive desktop — the whole point of
// the two-stage split. Params arrive on stdin, the result goes out on stdout,
// then this process holds the desktop grant until the launched process exits.
func MaybeRunSessionLaunchHelper() {
	isHelper := false
	for _, a := range os.Args[1:] {
		if a == sessionLaunchHelperFlag {
			isHelper = true
			break
		}
	}
	if !isHelper {
		return
	}

	var p sessionLaunchParams
	if err := json.NewDecoder(os.Stdin).Decode(&p); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(sessionLaunchResult{
			Reason: "session_helper_failed", Err: "decoding params: " + err.Error()})
		os.Exit(1)
	}

	out := inSessionLaunch(launchParams{
		Username:    p.Username,
		Password:    p.Password,
		TargetPath:  p.TargetPath,
		CommandLine: p.CommandLine,
		SessionID:   p.SessionID,
	})
	res := sessionLaunchResult{PID: out.pid, Reason: out.reason}
	if out.err != nil {
		res.Err = out.err.Error()
	}
	_ = json.NewEncoder(os.Stdout).Encode(res)
	if out.reason != "" {
		os.Exit(1)
	}

	// Hold the desktop/winsta grant (and profile/env/token) for the launched
	// process's UI lifetime, then clean up and exit. Cleaning up earlier tears
	// the ACE out from under conhost/GUI before the window paints (the
	// black-window bug). If this helper is killed first, the grant simply leaks
	// for the now-dead ephemeral logon SID — harmless.
	windows.WaitForSingleObject(out.proc, windows.INFINITE)
	out.cleanup()
	windows.CloseHandle(out.proc)
	os.Exit(0)
}

// inSessionOutcome carries the raw launch result plus a cleanup func the helper
// runs once the launched process exits. proc and cleanup are only valid when
// reason=="". cleanup revokes the desktop grant, unloads the profile, frees the
// environment block, and closes the launch token — all of which must outlive
// the launched process's UI, so ownership transfers to the caller.
type inSessionOutcome struct {
	pid     uint32
	reason  string
	err     error
	proc    windows.Handle
	cleanup func()
}

// inSessionLaunch performs: LogonUser(user,pwd) → linked-token swap →
// SetTokenInformation(TokenSessionId) → grant the logon SID access to
// winsta0\default → best-effort LoadUserProfile/CreateEnvironmentBlock →
// CreateProcessAsUser(target, cmdline, lpDesktop="winsta0\\default").
// It MUST run inside the target interactive session (see
// MaybeRunSessionLaunchHelper) so the winsta/desktop grant lands on the session
// that actually renders. On success it returns the launched process handle and
// a cleanup func; the caller owns their lifetime. On any step failure it
// returns the matching Reason and leaks no handles.
func inSessionLaunch(p launchParams) inSessionOutcome {
	// 1. LogonUser(user, ".", pwd, INTERACTIVE, DEFAULT) → primary token.
	tok, err := logonUser(p.Username, ".", p.Password)
	if err != nil {
		return inSessionOutcome{reason: "logon_failed", err: err}
	}

	// 1b. LogonUser hands back the UAC-FILTERED (limited) token for a
	//     split-token admin; CreateProcessAsUser with it fails
	//     ERROR_ELEVATION_REQUIRED when the target needs elevation. Swap to the
	//     elevated linked token, duplicated to a primary token (GetLinkedToken
	//     yields an impersonation token; CreateProcessAsUser needs a primary).
	//     launchTok is the token we launch with; its lifetime must extend past
	//     the launched process (UnloadUserProfile needs it), so it is NOT
	//     defer-closed here — cleanup (or the failure paths below) owns it.
	launchTok := tok
	if !tok.IsElevated() {
		linked, err := tok.GetLinkedToken()
		if err != nil {
			windows.CloseHandle(windows.Handle(tok))
			return inSessionOutcome{reason: "linked_token_failed", err: err}
		}
		var primary windows.Token
		if err := windows.DuplicateTokenEx(linked, windows.TOKEN_ALL_ACCESS, nil,
			windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
			windows.CloseHandle(windows.Handle(linked))
			windows.CloseHandle(windows.Handle(tok))
			return inSessionOutcome{reason: "linked_token_failed", err: err}
		}
		windows.CloseHandle(windows.Handle(linked))
		windows.CloseHandle(windows.Handle(tok)) // filtered token no longer needed
		launchTok = primary
	}
	// failClose closes launchTok on any failure path below (success transfers it
	// to cleanup instead).
	failClose := true
	defer func() {
		if failClose {
			windows.CloseHandle(windows.Handle(launchTok))
		}
	}()

	// 2. Retarget the token at the interactive session so the process lands on
	//    the user's desktop, not session 0. SYSTEM holds SE_TCB_NAME. (The
	//    LogonUser token is created in session 0 regardless of the helper's own
	//    session, so this stamp is still required here.)
	sess := p.SessionID
	if err := windows.SetTokenInformation(launchTok, windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sess)), uint32(unsafe.Sizeof(sess))); err != nil {
		return inSessionOutcome{reason: "set_session_failed", err: err}
	}

	// 3. Grant the token's logon SID access to winsta0 + its default desktop,
	//    else the process starts with no visible (paintable) window. Because
	//    this runs inside the target session, winsta0\default resolves to the
	//    session that renders — the fix for VM finding #2(b).
	sid, err := tokenLogonSID(launchTok)
	if err != nil {
		return inSessionOutcome{reason: "desktop_grant_failed", err: err}
	}
	revoke, err := grantSIDToInteractiveDesktop(sid)
	if err != nil {
		return inSessionOutcome{reason: "desktop_grant_failed", err: err}
	}
	revokeOnFail := true
	defer func() {
		if revokeOnFail {
			revoke()
		}
	}()

	// 3b. Best-effort profile + environment block. Without a loaded profile the
	//     account has no HKCU/APPDATA, and some targets (notably mmc.exe and its
	//     snap-ins) exit immediately. Failures are non-fatal: fall back to the
	//     SYSTEM service environment (nil), which still launches + paints —
	//     profile-loading is NOT the black-window fix (VM finding #2(b)).
	hProfile := loadUserProfile(launchTok, p.Username)
	envBlock := createEnvironmentBlock(launchTok)

	// 4. Launch the target as the token, pinned to winsta0\default.
	desktop, err := windows.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		unloadUserProfile(launchTok, hProfile)
		destroyEnvironmentBlock(envBlock)
		return inSessionOutcome{reason: "create_process_failed", err: err}
	}
	appName, err := windows.UTF16PtrFromString(p.TargetPath)
	if err != nil {
		unloadUserProfile(launchTok, hProfile)
		destroyEnvironmentBlock(envBlock)
		return inSessionOutcome{reason: "create_process_failed", err: err}
	}
	cmdLine, err := utf16MutablePtr(p.CommandLine)
	if err != nil {
		unloadUserProfile(launchTok, hProfile)
		destroyEnvironmentBlock(envBlock)
		return inSessionOutcome{reason: "create_process_failed", err: err}
	}
	si := windows.StartupInfo{Desktop: desktop}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	// CREATE_NEW_CONSOLE is required: a console target (cmd, powershell,
	// installers that spawn one) with dwCreationFlags=0 attaches to the
	// PARENT's console instead of allocating its own on the target session's
	// desktop — so it runs headless/invisible even though the token places it
	// in the right session. Forcing a new console makes the window appear on
	// winsta0\default in the user's session. GUI targets ignore it. (Found on
	// VM: launch reported OK in session 3 but no visible window.)
	creationFlags := uint32(windows.CREATE_NEW_CONSOLE)
	var envPtr *uint16
	if envBlock != nil {
		// A CreateEnvironmentBlock block is always Unicode.
		creationFlags |= windows.CREATE_UNICODE_ENVIRONMENT
		envPtr = envBlock
	}
	if err := windows.CreateProcessAsUser(launchTok, appName, cmdLine,
		nil, nil, false, creationFlags, envPtr, nil, &si, &pi); err != nil {
		unloadUserProfile(launchTok, hProfile)
		destroyEnvironmentBlock(envBlock)
		return inSessionOutcome{reason: "create_process_failed", err: err}
	}
	windows.CloseHandle(pi.Thread)

	// Success: transfer ownership of the grant, profile, env block, and token to
	// the caller, which holds them until the launched process exits.
	failClose = false
	revokeOnFail = false
	cleanup := func() {
		revoke()
		destroyEnvironmentBlock(envBlock)
		unloadUserProfile(launchTok, hProfile)
		windows.CloseHandle(windows.Handle(launchTok))
	}
	return inSessionOutcome{pid: pi.ProcessId, proc: pi.Process, cleanup: cleanup}
}

// loadUserProfile best-effort loads the account's profile hive for tok so the
// launched process has HKCU/APPDATA. Returns 0 (and logs) on failure; callers
// pass the returned handle to unloadUserProfile unconditionally.
func loadUserProfile(tok windows.Token, username string) windows.Handle {
	uPtr, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return 0
	}
	pi := profileInfo{Flags: piNoUI, Username: uPtr}
	pi.Size = uint32(unsafe.Sizeof(pi))
	r1, _, e1 := procLoadUserProfileW.Call(uintptr(tok), uintptr(unsafe.Pointer(&pi)))
	if r1 == 0 {
		slog.Warn("pamactuator: token_launch LoadUserProfile failed, launching with SYSTEM env",
			"user", username, "err", e1)
		return 0
	}
	return pi.Profile
}

// unloadUserProfile unloads a profile handle from loadUserProfile (no-op on 0).
func unloadUserProfile(tok windows.Token, hProfile windows.Handle) {
	if hProfile == 0 {
		return
	}
	procUnloadUserProfile.Call(uintptr(tok), uintptr(hProfile))
}

// createEnvironmentBlock best-effort builds the account's environment block
// (bInherit=false: don't merge SYSTEM's env). Returns nil on failure so the
// caller falls back to the default (nil) environment.
func createEnvironmentBlock(tok windows.Token) *uint16 {
	var env *uint16
	r1, _, e1 := procCreateEnvironmentBlock.Call(
		uintptr(unsafe.Pointer(&env)), uintptr(tok), 0)
	if r1 == 0 {
		slog.Warn("pamactuator: token_launch CreateEnvironmentBlock failed, launching with SYSTEM env",
			"err", e1)
		return nil
	}
	return env
}

// destroyEnvironmentBlock frees a block from createEnvironmentBlock (no-op nil).
func destroyEnvironmentBlock(env *uint16) {
	if env == nil {
		return
	}
	procDestroyEnvironmentBlock.Call(uintptr(unsafe.Pointer(env)))
}

// duplicateSystemTokenForSession duplicates this process's (SYSTEM) token as a
// primary token stamped to sessionID, suitable for CreateProcessAsUser to place
// a SYSTEM helper into that interactive session. SYSTEM holds SE_TCB_NAME, which
// TokenSessionId requires.
func duplicateSystemTokenForSession(sessionID uint32) (windows.Token, error) {
	var procTok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY, &procTok); err != nil {
		return 0, err
	}
	defer procTok.Close()
	var dup windows.Token
	if err := windows.DuplicateTokenEx(procTok, windows.TOKEN_ALL_ACCESS, nil,
		windows.SecurityImpersonation, windows.TokenPrimary, &dup); err != nil {
		return 0, err
	}
	sess := sessionID
	if err := windows.SetTokenInformation(dup, windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sess)), uint32(unsafe.Sizeof(sess))); err != nil {
		dup.Close()
		return 0, err
	}
	return dup, nil
}

// logonUser wraps advapi32!LogonUserW (not exported by x/sys/windows) and
// returns a primary token for the account.
func logonUser(username, domain, password string) (windows.Token, error) {
	uPtr, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return 0, err
	}
	dPtr, err := windows.UTF16PtrFromString(domain)
	if err != nil {
		return 0, err
	}
	pPtr, err := windows.UTF16PtrFromString(password)
	if err != nil {
		return 0, err
	}
	var tok windows.Token
	r1, _, e1 := procLogonUserW.Call(
		uintptr(unsafe.Pointer(uPtr)),
		uintptr(unsafe.Pointer(dPtr)),
		uintptr(unsafe.Pointer(pPtr)),
		logon32LogonInteractive,
		logon32ProviderDefault,
		uintptr(unsafe.Pointer(&tok)),
	)
	if r1 == 0 {
		return 0, e1
	}
	return tok, nil
}

// tokenLogonSID returns a copy of the token's logon SID — the unique
// S-1-5-5-X-Y the SRM stamps into an interactive logon, and the SID the
// window-station/desktop DACLs must grant for the process to paint.
func tokenLogonSID(tok windows.Token) (*windows.SID, error) {
	groups, err := tok.GetTokenGroups()
	if err != nil {
		return nil, err
	}
	for _, g := range groups.AllGroups() {
		if g.Attributes&windows.SE_GROUP_LOGON_ID == windows.SE_GROUP_LOGON_ID {
			return g.Sid.Copy()
		}
	}
	return nil, errors.New("no logon SID present in token groups")
}

// grantSIDToInteractiveDesktop adds an allow-all ACE for sid to both the
// "winsta0" window station and its "default" desktop DACL, returning a revoke
// func that restores both original DACLs. Either failure leaves nothing to
// revoke for the object that failed.
func grantSIDToInteractiveDesktop(sid *windows.SID) (func(), error) {
	winsta, err := openWindowStation("winsta0")
	if err != nil {
		return nil, err
	}
	revokeWinsta, err := grantSIDToObject(windows.Handle(winsta), sid)
	if err != nil {
		procCloseWindowStation.Call(winsta)
		return nil, err
	}

	desk, err := openDesktop("default")
	if err != nil {
		revokeWinsta()
		procCloseWindowStation.Call(winsta)
		return nil, err
	}
	revokeDesk, err := grantSIDToObject(windows.Handle(desk), sid)
	if err != nil {
		procCloseDesktop.Call(desk)
		revokeWinsta()
		procCloseWindowStation.Call(winsta)
		return nil, err
	}

	return func() {
		revokeDesk()
		procCloseDesktop.Call(desk)
		revokeWinsta()
		procCloseWindowStation.Call(winsta)
	}, nil
}

// grantSIDToObject merges an allow-GENERIC_ALL ACE for sid into handle's DACL
// (a SE_WINDOW_OBJECT) and returns a func that restores the original DACL.
func grantSIDToObject(handle windows.Handle, sid *windows.SID) (func(), error) {
	sd, err := windows.GetSecurityInfo(handle, windows.SE_WINDOW_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return nil, err
	}
	oldDACL, _, err := sd.DACL()
	if err != nil {
		return nil, err
	}
	entries := []windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       noInheritance,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}}
	newDACL, err := windows.ACLFromEntries(entries, oldDACL)
	if err != nil {
		return nil, err
	}
	if err := windows.SetSecurityInfo(handle, windows.SE_WINDOW_OBJECT,
		windows.DACL_SECURITY_INFORMATION, nil, nil, newDACL, nil); err != nil {
		return nil, err
	}
	return func() {
		windows.SetSecurityInfo(handle, windows.SE_WINDOW_OBJECT,
			windows.DACL_SECURITY_INFORMATION, nil, nil, oldDACL, nil)
		runtime.KeepAlive(sd)
	}, nil
}

// openWindowStation opens a named window station with rights to read and
// rewrite its DACL.
func openWindowStation(name string) (uintptr, error) {
	nPtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	r1, _, e1 := procOpenWindowStationW.Call(
		uintptr(unsafe.Pointer(nPtr)), 0, readControlAccess|writeDACAccess)
	if r1 == 0 {
		return 0, e1
	}
	return r1, nil
}

// openDesktop opens a named desktop on the current window station with rights
// to read and rewrite its DACL.
func openDesktop(name string) (uintptr, error) {
	nPtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	r1, _, e1 := procOpenDesktopW.Call(
		uintptr(unsafe.Pointer(nPtr)), 0, 0, readControlAccess|writeDACAccess)
	if r1 == 0 {
		return 0, e1
	}
	return r1, nil
}

// utf16MutablePtr returns a pointer to a writable UTF-16 copy of s, as required
// for CreateProcessAsUser's lpCommandLine (the API may modify the buffer).
func utf16MutablePtr(s string) (*uint16, error) {
	u, err := windows.UTF16FromString(s)
	if err != nil {
		return nil, err
	}
	return &u[0], nil
}
