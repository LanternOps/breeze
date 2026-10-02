package heartbeat

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdSupportEnd] = handleSupportEnd
}

// supportEndFlushDelay is how long the async teardown waits before removing
// the workspace and exiting, so the command result submitted by the caller
// has time to reach the server over the WebSocket. Short: the technician has
// already ended the session and the user is watching a window that should
// close.
const supportEndFlushDelay = 500 * time.Millisecond

// Seams so the handler's contract — refuse when not in support mode, and
// never touch the filesystem or the process in that case — is unit-testable
// without deleting directories or exiting the test binary.
var (
	supportCleanupFn = supportCleanup
	supportExitFn    = os.Exit
	// Stubbed in tests for an obvious reason: the real implementation deletes
	// the running executable, which under `go test` is the test binary.
	supportSelfDeleteFn = scheduleSupportSelfDelete
)

// supportWorkDirPrefix is the name every support folder carries (see
// supportWorkDir in internal/agentapp). The folder is only ever removed, in
// process or after exit, when its name has this prefix.
const supportWorkDirPrefix = "breeze-support-"

func isSupportWorkDir(dir string) bool {
	return dir != "" && strings.HasPrefix(filepath.Base(dir), supportWorkDirPrefix)
}

// handleSupportEnd tears down an ephemeral Quick Support client: the
// technician ended the session (or the server revoked it), so this process
// stops sharing, deletes its temp workspace, schedules the deletion of its
// own executable, and exits.
//
// THE GUARD: a heartbeat that is not in support mode refuses outright. This
// command is a self-destruct, and support_end is delivered over the same
// command channel as everything else — a forged command, a server-side
// mis-routing to the wrong device, or a stale session id must never be able
// to wipe a real, permanently-installed agent. Support mode is a runtime-only
// config field (`mapstructure:"-"`, see config.Config.SupportMode) that is set
// exactly once, by runSupportSession, so it cannot be turned on by anything
// that arrives over the network or lands on disk.
func handleSupportEnd(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	sessionID := tools.GetPayloadString(cmd.Payload, "sessionId", "")

	if !h.supportMode {
		log.Warn("REFUSED support_end: this agent is not a Quick Support client",
			"sessionId", sessionID,
			"commandId", cmd.ID,
		)
		return tools.NewErrorResult(
			errors.New("support_end refused: this agent is a permanently-installed Breeze agent, not an ephemeral Quick Support client; nothing was removed"),
			time.Since(start).Milliseconds(),
		)
	}

	log.Info("support_end received — ending Quick Support session and self-destructing",
		"sessionId", sessionID,
		"workDir", h.supportWorkDir,
	)

	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic during Quick Support teardown", "panic", fmt.Sprint(r))
			}
		}()
		// Let the success result below reach the wire before the process dies.
		time.Sleep(supportEndFlushDelay)
		supportCleanupFn(h)
		supportExitFn(0)
	}()

	return tools.NewSuccessResult(map[string]string{
		"message":   "support session ended; client is self-destructing",
		"sessionId": sessionID,
	}, time.Since(start).Milliseconds())
}

// supportCleanup performs the local teardown of a Quick Support client: stop
// sharing the screen, remove the temp workspace (config + secrets + log), and
// schedule the deletion of the executable itself.
//
// Everything here is local — no network I/O. The signal path in
// runSupportSession runs this same function, and a console X-close on Windows
// gives roughly 5 seconds of grace, so a blocking HTTP call here would mean
// the workspace (which holds this session's device token) survives.
//
// Never called on a permanently-installed agent: the only two callers are
// handleSupportEnd (guarded on h.supportMode) and RunSupportCleanup.
func supportCleanup(h *Heartbeat) {
	if h == nil {
		return
	}

	if h.desktopMgr != nil {
		h.desktopMgr.StopAllSessions()
	}
	if h.wsDesktopMgr != nil {
		h.wsDesktopMgr.StopAll()
	}

	// Release the files the session still holds open in its folder (its log)
	// before removing it: on Windows an open file keeps the folder in place.
	// Logging is discarded from here on, so nothing re-creates the log.
	if h.supportReleaseFiles != nil {
		h.supportReleaseFiles()
	}

	// Belt-and-braces against ever removing a real install's config dir: the
	// workspace is only ever the temp directory runSupportSession created.
	// A failure is not logged: logging was discarded by the release above.
	// Whatever this process still holds is removed by the post-exit cleanup.
	if isSupportWorkDir(h.supportWorkDir) {
		_ = removeSupportWorkDir(h.supportWorkDir)
	}

	// Removes the executable, and whatever of the folder this process still
	// held, once the process has exited. A no-op if teardown already started
	// it (ScheduleSupportSelfCleanup).
	h.scheduleSupportSelfCleanup()
}

// removeSupportWorkDir removes dir, retrying briefly: on Windows a handle that
// is being closed, or an antivirus scan of a just-written file, can make the
// first attempt fail with a sharing violation.
func removeSupportWorkDir(dir string) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = os.RemoveAll(dir); err == nil {
			return nil
		}
		if runtime.GOOS != "windows" {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
	return err
}

// scheduleSupportSelfCleanup starts the post-exit cleanup once per process.
func (h *Heartbeat) scheduleSupportSelfCleanup() {
	h.supportSelfCleanupOnce.Do(func() {
		workDir := h.supportWorkDir
		if !isSupportWorkDir(workDir) {
			workDir = ""
		}
		supportSelfDeleteFn(workDir)
	})
}

// ScheduleSupportSelfCleanup starts, at the beginning of a support session's
// teardown, the cleanup that runs after this process exits: it deletes the
// executable and removes the support folder. runSupportSession calls it
// first, before the agent shuts down, because closing the console window
// allows only about five seconds before Windows ends the process, and the
// shutdown can take longer. supportCleanup starts it too (for the
// technician-ended path); only the first call does anything.
func (h *Heartbeat) ScheduleSupportSelfCleanup() {
	if h == nil || !h.supportMode {
		return
	}
	h.scheduleSupportSelfCleanup()
}

// SetSupportFileReleaser registers what supportCleanup calls to close the
// files the session holds open in its folder (the log) before removing it.
func (h *Heartbeat) SetSupportFileReleaser(release func()) {
	if h == nil {
		return
	}
	h.supportReleaseFiles = release
}

// RunSupportCleanup runs the Quick Support teardown from outside this package.
// The support-mode foreground runner (internal/agentapp) calls it on Ctrl+C /
// SIGTERM so a user-initiated close destroys exactly as much as a
// server-initiated support_end does.
func (h *Heartbeat) RunSupportCleanup() {
	if h == nil || !h.supportMode {
		return
	}
	supportCleanupFn(h)
}

// Environment variables that carry the cleanup's paths to cmd.exe.
const (
	supportCleanupExeEnv = "BREEZE_SUPPORT_CLEANUP_EXE"
	supportCleanupDirEnv = "BREEZE_SUPPORT_CLEANUP_DIR"
)

// buildSupportSelfDeleteCmdLine renders the Windows trampoline command line
// and the environment entries it reads its paths from. Extracted (like
// buildWindowsUninstallScript) so the exact text is unit-testable on any host
// without spawning cmd.exe.
//
// The paths are passed in the environment, never written into the line:
// cmd.exe expands %NAME% anywhere in its command line, quoted or not, with no
// escape, so a user or file name containing % would otherwise make it delete
// a different path. They are read with delayed expansion (cmd /V:ON,
// !NAME!), which happens after the FOR loop variable is substituted and does
// not re-read the value, so neither a %NAME% nor a %i in a path is replaced.
//
// It polls about once a second for up to a minute: the executable cannot be
// deleted while this process is still running, and a file it still holds
// keeps the folder in place, so the first attempt that can succeed is the one
// after exit. It stops as soon as both are gone. workDir "" deletes only the
// executable.
func buildSupportSelfDeleteCmdLine(exePath, workDir string) (string, []string) {
	exeRef := `"!` + supportCleanupExeEnv + `!"`
	env := []string{supportCleanupExeEnv + "=" + exePath}
	steps := `ping 127.0.0.1 -n 2 >NUL & del /f /q ` + exeRef + ` 2>NUL`
	done := `if not exist ` + exeRef
	if workDir != "" {
		dirRef := `"!` + supportCleanupDirEnv + `!"`
		env = append(env, supportCleanupDirEnv+"="+workDir)
		steps += ` & rmdir /s /q ` + dirRef + ` 2>NUL`
		done += ` if not exist ` + dirRef
	}
	return fmt.Sprintf(`cmd /V:ON /C for /L %%i in (1,1,60) do (%s & %s exit)`, steps, done), env
}

// scheduleSupportSelfDelete deletes this executable, and removes workDir
// (unless ""), after the process exits. Best-effort by nature: if it fails,
// the user is left with a downloaded file they can delete, not with anything
// installed or running.
func scheduleSupportSelfDelete(workDir string) {
	exePath, err := os.Executable()
	if err != nil || exePath == "" {
		log.Warn("could not resolve own executable path; skipping Quick Support self-delete", "error", fmt.Sprint(err))
		return
	}
	if err := startSupportSelfDelete(exePath, workDir); err != nil {
		log.Warn("could not schedule Quick Support self-delete", "path", exePath, "error", err.Error())
	}
}
