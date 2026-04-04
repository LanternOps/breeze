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

// findOrSpawnHelper locates a capable helper session, spawning one if needed.
func (h *Heartbeat) findOrSpawnHelper(targetSession string) *sessionbroker.Session {
	session := h.sessionBroker.FindCapableSession("capture", targetSession)
	if runtime.GOOS == "darwin" {
		if preferred := h.sessionBroker.PreferredDesktopSession(); preferred != nil {
			session = preferred
		}
	}
	if targetSession != "" && session != nil && session.WinSessionID != targetSession {
		session = nil
	}

	// Validate the helper's Windows session is still active.
	if session != nil && targetSession == "" && isWinSessionDisconnected(session.WinSessionID) {
		log.Warn("helper is in a disconnected Windows session, spawning new helper",
			"helperSession", session.SessionID,
			"winSession", session.WinSessionID)
		session = nil
	}

	if session != nil {
		return session
	}

	// Serialize spawns per target session
	mu := sessionSpawnMu(targetSession)
	mu.Lock()
	defer mu.Unlock()

	// Re-check after lock
	session = h.sessionBroker.FindCapableSession("capture", targetSession)
	if runtime.GOOS == "darwin" {
		if preferred := h.sessionBroker.PreferredDesktopSession(); preferred != nil {
			session = preferred
		}
	}
	if targetSession != "" && session != nil && session.WinSessionID != targetSession {
		session = nil
	}
	if session != nil && targetSession == "" && isWinSessionDisconnected(session.WinSessionID) {
		session = nil
	}
	if session != nil {
		return session
	}

	if err := h.spawnDesktopHelper(targetSession); err != nil {
		log.Warn("helper spawn failed", "error", err.Error())
		return nil
	}

	// Poll for the helper to connect (up to 10s)
	for i := 0; i < 100; i++ {
		time.Sleep(100 * time.Millisecond)
		session = h.sessionBroker.FindCapableSession("capture", targetSession)
		if runtime.GOOS == "darwin" {
			if preferred := h.sessionBroker.PreferredDesktopSession(); preferred != nil {
				session = preferred
			}
		}
		if targetSession != "" && session != nil && session.WinSessionID != targetSession {
			session = nil
		}
		if session != nil && (targetSession != "" || !isWinSessionDisconnected(session.WinSessionID)) {
			return session
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
    <string>/tmp/breeze-desktop-helper-user.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/breeze-desktop-helper-user.log</string>
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
    <string>/tmp/breeze-desktop-helper-loginwindow.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/breeze-desktop-helper-loginwindow.log</string>
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

		var consoleFallback, activeFallback, connectedFallback string
		for _, ds := range detected {
			if ds.Type == "services" {
				continue
			}
			// Console session is always preferred
			if ds.Session == consoleID && (ds.State == "active" || ds.State == "connected") {
				consoleFallback = ds.Session
			}
			if ds.State == "active" && activeFallback == "" {
				activeFallback = ds.Session
			}
			if ds.State == "connected" && connectedFallback == "" {
				connectedFallback = ds.Session
			}
		}

		// Priority: console > any active > any connected
		switch {
		case consoleFallback != "":
			targetSession = consoleFallback
		case activeFallback != "":
			targetSession = activeFallback
		case connectedFallback != "":
			targetSession = connectedFallback
		default:
			return fmt.Errorf("no active or connected non-services session found")
		}
	}

	sessionNum, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(targetSession)
	if err != nil {
		return fmt.Errorf("invalid session ID %q: %w", targetSession, err)
	}

	// Kill any stale helpers from previous sessions in this Windows session
	// to release DXGI Desktop Duplication locks before spawning a new one.
	h.killDesktopStaleHelpers(targetSession)

	return sessionbroker.SpawnHelperInSession(sessionNum)
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
