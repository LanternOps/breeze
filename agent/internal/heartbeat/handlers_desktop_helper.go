package heartbeat

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// spawnGuards holds a per-session mutex so that spawns into different Windows
// sessions can proceed in parallel. The sync.Map key is the target session ID
// string (or "" for auto-detect).
var spawnGuards sync.Map

const maxGUIUserUIDs = 64

// sessionSpawnMu returns a mutex for the given session key, creating one if needed.
func sessionSpawnMu(sessionKey string) *sync.Mutex {
	val, _ := spawnGuards.LoadOrStore(sessionKey, &sync.Mutex{})
	return val.(*sync.Mutex)
}

// isWinSessionDisconnected checks whether the given Windows session ID is
// disconnected (no active display). Helpers in disconnected sessions cannot
// capture the screen. Returns false on non-Windows or if the state can't be
// determined.
func isWinSessionDisconnected(winSessionID string) bool {
	if winSessionID == "" || winSessionID == "0" {
		return false
	}
	return sessionbroker.IsSessionDisconnected(winSessionID)
}

func (h *Heartbeat) helperSessionForTarget(targetSession string) *sessionbroker.Session {
	if h.helperFinder != nil {
		return h.helperFinder(targetSession)
	}
	return h.findOrSpawnHelper(targetSession)
}

func (h *Heartbeat) spawnDesktopHelper(targetSession string) error {
	if h.spawnHelper != nil {
		return h.spawnHelper(targetSession)
	}
	return h.spawnHelperForDesktop(targetSession)
}

func (h *Heartbeat) killDesktopStaleHelpers(targetSession string) {
	if targetSession == "" {
		return
	}
	staleKey := targetSession + "-" + ipc.HelperRoleSystem
	if h.killStaleHelpers != nil {
		h.killStaleHelpers(staleKey)
		return
	}
	if h.sessionBroker != nil {
		h.sessionBroker.KillStaleHelpers(staleKey)
	}
}

func (h *Heartbeat) rememberDesktopOwner(desktopSessionID, helperSessionID string) {
	if desktopSessionID == "" || helperSessionID == "" {
		return
	}
	h.desktopOwners.Store(desktopSessionID, helperSessionID)
}

func (h *Heartbeat) forgetDesktopOwner(desktopSessionID string) {
	if desktopSessionID == "" {
		return
	}
	h.desktopOwners.Delete(desktopSessionID)
}

func (h *Heartbeat) desktopOwnerSession(desktopSessionID string) *sessionbroker.Session {
	if desktopSessionID == "" || h.sessionBroker == nil {
		return nil
	}
	helperSessionID, ok := h.desktopOwners.Load(desktopSessionID)
	if !ok {
		return nil
	}
	helperSessionIDStr, ok := helperSessionID.(string)
	if !ok || helperSessionIDStr == "" {
		return nil
	}
	return h.sessionBroker.SessionByID(helperSessionIDStr)
}

// startDesktopViaHelper routes a desktop start request through the IPC user helper.
// If the helper crashes during the request, it automatically respawns and retries.
// On macOS, it pre-checks TCC Screen Recording permission and returns a clear error
// if the required permissions haven't been configured yet.
func (h *Heartbeat) startDesktopViaHelper(sessionID, offer string, iceServers []desktop.ICEServerConfig, displayIndex int, payload map[string]any) tools.CommandResult {
	// Log TCC status for diagnostics but don't gate — the cached status may be
	// stale (e.g. permission just granted). Let the capturer attempt and fail
	// with the real error instead of blocking on a potentially outdated check.
	if runtime.GOOS == "darwin" && h.sessionBroker != nil {
		if tccStatus := h.sessionBroker.TCCStatus(); tccStatus != nil && !tccStatus.ScreenRecording {
			log.Warn("TCC Screen Recording not yet reported as granted — attempting capture anyway",
				"screenRecording", tccStatus.ScreenRecording,
				"fullDiskAccess", tccStatus.FullDiskAccess,
			)
		}
	}

	// Read optional target Windows session ID from payload
	targetSession := ""
	if ts, ok := payload["targetSessionId"].(float64); ok {
		targetSession = fmt.Sprintf("%d", int(ts))
	}

	// Read optional GPU vendor hint from payload (set by API from device hardware inventory)
	gpuVendor := ""
	if v, ok := payload["gpuVendor"].(string); ok {
		gpuVendor = v
	}

	// Marshal ICE servers once (used across retries)
	var iceRaw json.RawMessage
	if len(iceServers) > 0 {
		data, err := json.Marshal(iceServers)
		if err != nil {
			return tools.NewErrorResult(fmt.Errorf("failed to marshal ICE servers: %w", err), 0)
		}
		iceRaw = data
	}

	req := ipc.DesktopStartRequest{
		SessionID:    sessionID,
		Offer:        offer,
		ICEServers:   iceRaw,
		DisplayIndex: displayIndex,
		GPUVendor:    gpuVendor,
	}

	// Retry up to 2 times: if the helper crashes during SendCommand, respawn
	// and retry immediately instead of failing back to the API (which adds
	// 20-30s of round-trip delay).
	const maxAttempts = 2
	for attempt := 0; attempt < maxAttempts; attempt++ {
		session := h.helperSessionForTarget(targetSession)
		if session == nil {
			return tools.NewErrorResult(fmt.Errorf("no capable helper available after spawn attempt"), 0)
		}

		resp, err := session.SendCommand("desk-"+sessionID, ipc.TypeDesktopStart, req, 30*time.Second)
		if err != nil {
			log.Warn("IPC desktop start failed, will retry with new helper",
				"attempt", attempt+1,
				"error", err.Error(),
				"session", session.SessionID,
			)
			continue
		}
		if resp.Error != "" {
			return tools.CommandResult{
				Status: "failed",
				Error:  resp.Error,
			}
		}

		var dResp ipc.DesktopStartResponse
		if err := json.Unmarshal(resp.Payload, &dResp); err != nil {
			return tools.NewErrorResult(fmt.Errorf("failed to unmarshal desktop start response: %w", err), 0)
		}
		h.rememberDesktopOwner(sessionID, session.SessionID)

		return tools.NewSuccessResult(map[string]any{
			"sessionId": sessionID,
			"answer":    dResp.Answer,
		}, 0)
	}

	return tools.NewErrorResult(fmt.Errorf("desktop start failed after %d attempts (helper keeps crashing)", maxAttempts), 0)
}

// findActiveHelper looks up a capable helper for the target session, applying
// macOS preference and preferring the console session on Windows. If the best
// session is disconnected, iterates all capable sessions looking for a
// non-disconnected one (preferring the console). Falls back to a disconnected
// session only when allowDisconnected is true.
func (h *Heartbeat) findActiveHelper(targetSession string, allowDisconnected ...bool) *sessionbroker.Session {
	session := h.sessionBroker.FindCapableSession("capture", targetSession)
	if runtime.GOOS == "darwin" {
		if preferred := h.sessionBroker.PreferredDesktopSession(); preferred != nil {
			session = preferred
		}
	}
	if targetSession != "" && session != nil && session.WinSessionID != targetSession {
		session = nil
	}

	// Issue #434: on Windows, if the caller pinned a target WTS session and we
	// can't find a helper for it, check whether the target session still exists
	// at the OS level. If it's gone (user logout tore it down), substitute any
	// capable helper so the viewer attaches to the new loginwindow / console
	// instead of endlessly retrying a vanished session. Logged at warn so we
	// can see the substitution in the shipper.
	if session == nil && targetSession != "" && runtime.GOOS == "windows" {
		if !winSessionStillExists(targetSession) {
			log.Warn("findActiveHelper: target WTS session no longer exists, falling back to any capable helper",
				"targetSession", targetSession)
			return h.findActiveHelper("", allowDisconnected...)
		}
	}

	// On Windows with no target specified, prefer the console session and
	// avoid disconnected sessions. The console is the physical display and
	// should always be the first pick; the viewer shows RDP sessions to
	// switch to if needed.
	if session != nil && targetSession == "" && runtime.GOOS == "windows" {
		consoleID := sessionbroker.GetConsoleSessionID()

		// If the best session IS the console and it's not disconnected, use it.
		// Hot path — fires on every start_desktop. Info-level; flip
		// `desktop_debug: true` in agent.yaml to ship. The "alternative",
		// "fallback", and "falling through" branches below remain at warn
		// because they're the interesting cases.
		if session.WinSessionID == consoleID && !isWinSessionDisconnected(session.WinSessionID) {
			log.Info("findActiveHelper: picked console session directly",
				"winSession", session.WinSessionID, "helperSession", session.SessionID,
				"consoleID", consoleID)
			return session
		}

		// Otherwise, look for a better alternative among all capable sessions.
		if alternatives := h.sessionBroker.SessionsWithScope("desktop"); len(alternatives) > 0 {
			var consoleAlt, nonDisconnectedAlt *sessionbroker.Session
			altSummaries := make([]string, 0, len(alternatives))
			for _, alt := range alternatives {
				caps := alt.GetCapabilities()
				canCapture := caps != nil && caps.CanCapture
				altSummaries = append(altSummaries,
					fmt.Sprintf("{win=%s disc=%v cap=%v}",
						alt.WinSessionID, isWinSessionDisconnected(alt.WinSessionID), canCapture))
				if !canCapture {
					continue
				}
				// Console session is always preferred
				if alt.WinSessionID == consoleID && consoleAlt == nil {
					consoleAlt = alt
				}
				if !isWinSessionDisconnected(alt.WinSessionID) && nonDisconnectedAlt == nil {
					nonDisconnectedAlt = alt
				}
			}
			if consoleAlt != nil && !isWinSessionDisconnected(consoleAlt.WinSessionID) {
				log.Warn("findActiveHelper: picked console alternative",
					"winSession", consoleAlt.WinSessionID, "helperSession", consoleAlt.SessionID,
					"consoleID", consoleID, "firstPick", session.WinSessionID,
					"alternatives", strings.Join(altSummaries, ","))
				return consoleAlt
			}
			if nonDisconnectedAlt != nil {
				log.Warn("findActiveHelper: picked non-disconnected alternative (no live console helper)",
					"winSession", nonDisconnectedAlt.WinSessionID, "helperSession", nonDisconnectedAlt.SessionID,
					"consoleID", consoleID, "firstPick", session.WinSessionID,
					"alternatives", strings.Join(altSummaries, ","))
				return nonDisconnectedAlt
			}
			// Console is disconnected but exists — prefer it over other disconnected sessions
			if consoleAlt != nil {
				if len(allowDisconnected) > 0 && allowDisconnected[0] {
					log.Warn("findActiveHelper: picked disconnected console as last resort",
						"winSession", consoleAlt.WinSessionID, "consoleID", consoleID)
					return consoleAlt
				}
				return nil
			}
		}

		// Original session is disconnected, no alternatives found
		if isWinSessionDisconnected(session.WinSessionID) {
			if len(allowDisconnected) == 0 || !allowDisconnected[0] {
				return nil
			}
		}
		log.Warn("findActiveHelper: falling through to first-pick session",
			"winSession", session.WinSessionID, "helperSession", session.SessionID,
			"consoleID", consoleID)
	}
	return session
}

// winSessionStillExists probes WTS to determine whether the given Windows
// session ID is still enumerated by the OS. Used to distinguish "helper hasn't
// spawned yet in this session" (retry worthwhile) from "session has been torn
// down by logout" (retry futile — substitute a different helper). On non-Windows
// or on probe failure, returns true as a conservative default so we don't
// over-substitute. Issue #434.
func winSessionStillExists(targetSession string) bool {
	if runtime.GOOS != "windows" || targetSession == "" {
		return true
	}
	detector := sessionbroker.NewSessionDetector()
	sessions, err := detector.ListSessions()
	if err != nil {
		// Conservative default: if the probe fails we claim the session
		// still exists so we don't aggressively substitute. But log it at
		// warn so the operator can see the substitution safety net has
		// been silently disabled — otherwise a reliably-failing probe
		// looks identical to a genuinely-live session.
		log.Warn("winSessionStillExists: WTS probe failed, assuming session still exists (#434 safety net disabled for this call)",
			"targetSession", targetSession,
			"error", err.Error())
		return true
	}
	for _, s := range sessions {
		if s.Session == targetSession {
			return true
		}
	}
	return false
}

// findOrSpawnHelper locates a capable helper session, spawning one if needed.
func (h *Heartbeat) findOrSpawnHelper(targetSession string) *sessionbroker.Session {
	session := h.findActiveHelper(targetSession)

	// Log when an existing helper is in a disconnected Windows session.
	if session == nil {
		if candidate := h.sessionBroker.FindCapableSession("capture", targetSession); candidate != nil && targetSession == "" && isWinSessionDisconnected(candidate.WinSessionID) {
			log.Warn("helper is in a disconnected Windows session, will try spawning new helper first",
				"helperSession", candidate.SessionID,
				"winSession", candidate.WinSessionID)
		}
	}

	if session != nil {
		return session
	}

	// Serialize spawns per target session
	mu := sessionSpawnMu(targetSession)
	mu.Lock()
	defer mu.Unlock()

	// Re-check after lock
	if session = h.findActiveHelper(targetSession); session != nil {
		return session
	}

	if err := h.spawnDesktopHelper(targetSession); err != nil {
		log.Warn("helper spawn failed", "error", err.Error())
		// Don't give up yet — fall through to disconnected-session fallback below.
	}

	// Poll for the helper to connect (up to 10s)
	for i := 0; i < 100; i++ {
		time.Sleep(100 * time.Millisecond)
		if session = h.findActiveHelper(targetSession); session != nil {
			return session
		}
	}

	// Last resort: accept a helper in a disconnected Windows session.
	// GDI/fallback capture can still work in disconnected sessions, and this
	// is common on cloud VMs (e.g. DigitalOcean) where RDP is not always active.
	if targetSession == "" {
		if session = h.findActiveHelper(targetSession, true); session != nil {
			log.Info("using helper in disconnected Windows session as fallback",
				"helperSession", session.SessionID,
				"winSession", session.WinSessionID)
			return session
		}
	}

	// Distinguish between helper not connecting at all vs connecting but lacking capture capability
	// (e.g. TCC Screen Recording not granted on macOS).
	if h.sessionBroker != nil {
		if desktopSessions := h.sessionBroker.SessionsWithScope("desktop"); len(desktopSessions) > 0 {
			log.Warn("helper connected but CanCapture is false — check Screen Recording permission (macOS) or session state (Windows)",
				"targetSession", targetSession,
				"connectedHelpers", len(desktopSessions),
			)
			return nil
		}
	}
	log.Warn("helper spawned but did not connect within 10s", "targetSession", targetSession)
	return nil
}

// darwinHelperPlists defines the LaunchAgent plists the agent writes to disk
// when they're missing, so the desktop helper self-configures without a .pkg.
var darwinHelperPlists = map[string]string{
	"/Library/LaunchAgents/com.breeze.desktop-helper-user.plist": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.desktop-helper-user</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-desktop-helper</string>
        <string>--context</string>
        <string>user_session</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`,
	"/Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.desktop-helper-loginwindow</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-desktop-helper</string>
        <string>--context</string>
        <string>login_window</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>LoginWindow</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`,
}

// ensureDarwinHelperPlists writes any missing LaunchAgent plists to disk.
// The agent runs as root so it can write to /Library/LaunchAgents/.
func ensureDarwinHelperPlists() {
	for path, content := range darwinHelperPlists {
		if _, err := os.Stat(path); err == nil {
			continue // already exists
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			log.Warn("failed to write helper plist", "path", path, "error", err.Error())
		} else {
			log.Info("installed helper LaunchAgent plist", "path", path)
		}
	}
}

// spawnHelperForDesktop spawns a user helper in the target session.
// If targetSession is empty, it auto-detects the first active non-services session.
func (h *Heartbeat) spawnHelperForDesktop(targetSession string) error {
	if runtime.GOOS != "windows" {
		// Ensure LaunchAgent plists exist on disk before any kickstart/bootstrap.
		ensureDarwinHelperPlists()

		if uids := findGUIUserUIDs(); len(uids) > 0 {
			bootstrapped := false
			for _, uid := range uids {
				domain := "gui/" + uid
				label := domain + "/com.breeze.desktop-helper-user"
				// kickstart -k kills any existing instance and restarts it.
				if err := exec.Command("launchctl", "kickstart", "-k", label).Run(); err == nil {
					log.Info("kickstarted desktop helper LaunchAgent", "uid", uid)
					return nil // let the caller's poll loop wait for the connection
				} else {
					log.Warn("launchctl kickstart failed, trying bootstrap",
						"uid", uid, "label", label, "error", err.Error())
				}
				// Fallback: try bootstrap in case the plist was never loaded.
				if err := exec.Command("launchctl", "bootstrap", domain,
					"/Library/LaunchAgents/com.breeze.desktop-helper-user.plist").Run(); err != nil {
					log.Warn("launchctl bootstrap also failed",
						"uid", uid, "domain", domain, "error", err.Error())
				} else {
					log.Info("bootstrapped desktop helper LaunchAgent", "uid", uid, "domain", domain)
					bootstrapped = true
				}
			}
			if bootstrapped {
				return nil // let the caller's poll loop wait for the connection
			}
		}
		if err := exec.Command("launchctl", "kickstart", "-k", "loginwindow/com.breeze.desktop-helper-loginwindow").Run(); err == nil {
			log.Info("kickstarted login-window desktop helper LaunchAgent")
			return nil
		}
		// Fallback: try bootstrap in case the plist was never loaded into the loginwindow domain.
		const loginwindowPlist = "/Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist"
		if err := exec.Command("launchctl", "bootstrap", "loginwindow", loginwindowPlist).Run(); err == nil {
			log.Info("bootstrapped login-window desktop helper LaunchAgent")
			return nil
		} else {
			log.Warn("launchctl bootstrap loginwindow also failed", "error", err.Error())
		}
		return fmt.Errorf("no desktop-helper connected; ensure the LaunchAgents are loaded")
	}

	if targetSession == "" {
		// Prefer the physical console session (WTSGetActiveConsoleSessionId).
		// This avoids spawning into a disconnected RDP session.
		consoleID := sessionbroker.GetConsoleSessionID()

		detector := sessionbroker.NewSessionDetector()
		detected, err := detector.ListSessions()
		if err != nil {
			return fmt.Errorf("failed to list sessions: %w", err)
		}

		var consoleFallback, activeFallback, connectedFallback, disconnectedFallback string
		for _, ds := range detected {
			if ds.Type == "services" {
				continue
			}
			// Console session is always preferred regardless of state —
			// it's the physical display and should be the first pick.
			if ds.Session == consoleID && consoleFallback == "" {
				consoleFallback = ds.Session
			}
			if ds.State == "active" && activeFallback == "" {
				activeFallback = ds.Session
			}
			if ds.State == "connected" && connectedFallback == "" {
				connectedFallback = ds.Session
			}
			if ds.State == "disconnected" && disconnectedFallback == "" {
				disconnectedFallback = ds.Session
			}
		}

		// Priority: console > any active > any connected > disconnected (last resort)
		switch {
		case consoleFallback != "":
			targetSession = consoleFallback
		case activeFallback != "":
			targetSession = activeFallback
		case connectedFallback != "":
			targetSession = connectedFallback
		case disconnectedFallback != "":
			log.Info("no active/connected session found, using disconnected session as fallback",
				"session", disconnectedFallback)
			targetSession = disconnectedFallback
		default:
			return fmt.Errorf("no non-services session found (active, connected, or disconnected)")
		}
	}

	sessionNum, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(targetSession)
	if err != nil {
		return fmt.Errorf("invalid session ID %q: %w", targetSession, err)
	}

	// Kill any stale helpers from previous sessions in this Windows session
	// to release DXGI Desktop Duplication locks before spawning a new one.
	h.killDesktopStaleHelpers(targetSession)

	// The heartbeat path spawns a one-off helper; we don't track its exit
	// code here. Release the handle immediately — the lifecycle manager,
	// which does respect exit codes, owns the canonical spawn path.
	helper, err := sessionbroker.SpawnHelperInSession(sessionNum)
	if err != nil {
		return err
	}
	if helper != nil {
		helper.Close()
	}
	return nil
}

// findGUIUserUIDs returns the UIDs of users with a loginwindow process (macOS).
// Used to kickstart the helper LaunchAgent.
func findGUIUserUIDs() []string {
	if runtime.GOOS != "darwin" {
		return nil
	}
	out, err := exec.Command("ps", "-axo", "uid=,comm=").Output()
	if err != nil {
		log.Warn("failed to list processes for GUI user detection", "error", err.Error())
		return nil
	}
	return parseGUIUserUIDs(string(out))
}

// kickstartDarwinDesktopHelpers re-kickstarts the macOS desktop helper
// LaunchAgents for every logged-in GUI user session. This is called after a
// self-update restart to force helpers to reconnect to the new IPC socket
// immediately instead of waiting for their reconnect backoff.
func kickstartDarwinDesktopHelpers() {
	ensureDarwinHelperPlists()

	uids := findGUIUserUIDs()
	for _, uid := range uids {
		label := "gui/" + uid + "/com.breeze.desktop-helper-user"
		if err := exec.Command("launchctl", "kickstart", "-k", label).Run(); err != nil {
			log.Warn("post-update: launchctl kickstart failed",
				"uid", uid, "label", label, "error", err.Error())
		} else {
			log.Info("post-update: kickstarted desktop helper", "uid", uid)
		}
	}

	// Also kickstart the login-window helper.
	if err := exec.Command("launchctl", "kickstart", "-k",
		"loginwindow/com.breeze.desktop-helper-loginwindow").Run(); err != nil {
		log.Warn("post-update: launchctl kickstart login-window helper failed",
			"error", err.Error())
	} else {
		log.Info("post-update: kickstarted login-window desktop helper")
	}
}

func parseGUIUserUIDs(output string) []string {
	seen := map[string]bool{}
	var uids []string
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		uid, comm := fields[0], fields[len(fields)-1]
		// Skip root (uid 0) — its loginwindow process is the system login UI,
		// not a GUI user session. Bootstrapping into gui/0 always fails (exit 125).
		if uid == "0" {
			continue
		}
		if _, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(uid); err != nil {
			continue
		}
		if strings.HasSuffix(comm, "loginwindow") && !seen[uid] {
			seen[uid] = true
			uids = append(uids, uid)
			if len(uids) >= maxGUIUserUIDs {
				break
			}
		}
	}
	return uids
}
