package heartbeat

import (
	"errors"
	"fmt"
	"os"
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

	// Belt-and-braces against ever removing a real install's config dir: the
	// workspace is only ever the temp directory runSupportSession created.
	if h.supportWorkDir != "" {
		if err := os.RemoveAll(h.supportWorkDir); err != nil {
			log.Warn("could not remove Quick Support workspace", "path", h.supportWorkDir, "error", err.Error())
		}
	}

	supportSelfDeleteFn()
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

// SetSupportSessionNotifier wires console callbacks fired when a remote
// desktop session connects/disconnects. The stop callback is CHAINED onto
// whatever the heartbeat already registered (the peer-disconnect notification
// to the API) rather than replacing it.
//
// Must be called right after startAgent returns and before any session can
// start; the desktop manager's hooks are plain fields set at construction.
func (h *Heartbeat) SetSupportSessionNotifier(onStart, onStop func(sessionID string)) {
	if h == nil || h.desktopMgr == nil {
		return
	}
	previousStop := h.desktopMgr.OnSessionStopped
	h.desktopMgr.OnSessionStarted = onStart
	h.desktopMgr.OnSessionStopped = func(sessionID string) {
		if previousStop != nil {
			previousStop(sessionID)
		}
		if onStop != nil {
			onStop(sessionID)
		}
	}
}

// buildSupportSelfDeleteCmdLine renders the Windows trampoline command line.
// Extracted (like buildWindowsUninstallScript) so the exact text is
// unit-testable on any host without spawning cmd.exe.
func buildSupportSelfDeleteCmdLine(exePath string) string {
	return fmt.Sprintf(`cmd /C ping 127.0.0.1 -n 3 >NUL & del /f "%s"`, exePath)
}

// scheduleSupportSelfDelete removes this executable after the process exits.
// Best-effort by nature: if it fails, the user is left with a downloaded file
// they can delete, not with anything installed or running.
func scheduleSupportSelfDelete() {
	exePath, err := os.Executable()
	if err != nil || exePath == "" {
		log.Warn("could not resolve own executable path; skipping Quick Support self-delete", "error", fmt.Sprint(err))
		return
	}
	if err := startSupportSelfDelete(exePath); err != nil {
		log.Warn("could not schedule Quick Support self-delete", "path", exePath, "error", err.Error())
	}
}
