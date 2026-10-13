package sessionbroker

import (
	"sort"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Caller verification session selection (#6354 W02).
//
// A caller-verification card must reach exactly the person the technician
// named, at the physical console. Selection therefore starts from the OS, not
// from the helpers:
//
//  1. resolve the explicit OS login (detector) — no preferred-user fallback;
//  2. require that login to be the single active console session;
//  3. only then pick an Assist (Tauri) helper in that session that holds
//     consent_ui AND advertised callerVerify, and whose kernel-verified
//     identity owns that login (Windows: verified session id + SID→account;
//     Unix: peer UID).
//
// Deliberately NOT used: SessionForUser / PreferredSessionWithScope (they
// prefer native helpers and fall back across sessions), the native
// consent_ui_fallback helper, and the helper-supplied Username field, which
// is never identity evidence.

// Refusal reasons. These are the frozen `error` values of the caller_verify
// command result.
const (
	CallerVerifyNoSession      = "no_session_for_user"
	CallerVerifyNotConsole     = "session_not_console"
	CallerVerifyHelperOutdated = "helper_outdated"
)

// callerOwnsLogin reports whether the kernel-verified identity key (a SID on
// Windows) belongs to the detected login username. Platform files install
// the real check; tests override it.
var callerOwnsLogin = callerOwnsLoginOS

// CallerVerifySession selects the helper that may show a caller-verification
// card to username. On success the reason is "" and the returned
// DetectedSession is the detector's view of the login (its Username is the
// value to report). On refusal the session is nil and reason is one of the
// CallerVerify* constants.
func (b *Broker) CallerVerifySession(username string, detector SessionDetector) (*Session, DetectedSession, string) {
	if strings.TrimSpace(username) == "" || detector == nil {
		return nil, DetectedSession{}, CallerVerifyNoSession
	}
	logins, err := detector.ListSessions()
	if err != nil {
		return nil, DetectedSession{}, CallerVerifyNoSession
	}
	return b.callerVerifySessionFrom(username, logins)
}

// CallerVerifyUsers lists the detector usernames that could receive a card
// right now. It is heartbeat readiness telemetry, not authorization: every
// dispatch re-runs CallerVerifySession.
func (b *Broker) CallerVerifyUsers(detector SessionDetector) []string {
	users := []string{}
	if detector == nil {
		return users
	}
	logins, err := detector.ListSessions()
	if err != nil {
		return users
	}
	seen := map[string]bool{}
	for _, login := range logins {
		if login.Username == "" || seen[login.Username] {
			continue
		}
		if _, _, reason := b.callerVerifySessionFrom(login.Username, logins); reason == "" {
			seen[login.Username] = true
			users = append(users, login.Username)
		}
	}
	sort.Strings(users)
	return users
}

func (b *Broker) callerVerifySessionFrom(username string, logins []DetectedSession) (*Session, DetectedSession, string) {
	none := DetectedSession{}
	if strings.TrimSpace(username) == "" {
		return nil, none, CallerVerifyNoSession
	}
	b.mu.RLock()
	goos := b.effectiveGOOS()
	b.mu.RUnlock()
	consoleID := ""
	if goos == "windows" {
		consoleID = b.ConsoleSessionID()
	}

	var target *DetectedSession
	found := false
	for i := range logins {
		login := &logins[i]
		if login.UsernameUnknown {
			continue
		}
		same := login.Username == username
		if goos == "windows" {
			// Windows account names are case-insensitive.
			same = strings.EqualFold(login.Username, username)
		}
		if !same {
			continue
		}
		found = true
		if !isCallerConsoleLogin(goos, login, consoleID) {
			continue
		}
		if target != nil {
			// Two console logins for one name: never guess.
			return nil, none, CallerVerifyNotConsole
		}
		target = login
	}
	if !found {
		return nil, none, CallerVerifyNoSession
	}
	if target == nil {
		return nil, none, CallerVerifyNotConsole
	}

	sessions, _ := b.snapshotSessions()
	var best *Session
	for _, s := range sessions {
		if s.HelperRole != ipc.HelperRoleAssist || !s.HasScope(ipc.ScopeConsentUI) || s.IsClosed() {
			continue
		}
		if !callerHelperOwnsLogin(goos, s, target) {
			continue
		}
		caps := s.GetCapabilities()
		if caps == nil || !caps.CallerVerify {
			continue
		}
		if best == nil || s.SessionID < best.SessionID {
			best = s
		}
	}
	if best == nil {
		return nil, *target, CallerVerifyHelperOutdated
	}
	return best, *target, ""
}

func isCallerConsoleLogin(goos string, login *DetectedSession, consoleID string) bool {
	if login.IsRemote || login.State != "active" {
		return false
	}
	switch goos {
	case "windows":
		return login.Type == "console" && login.Session != "" && login.Session == consoleID
	case "darwin":
		return login.Type == "console"
	default:
		return login.Seat == "seat0" && (login.Display == "x11" || login.Display == "wayland" || login.Display == "mir")
	}
}

func callerHelperOwnsLogin(goos string, s *Session, login *DetectedSession) bool {
	if goos == "windows" {
		// The session id must be the kernel-verified one (not the helper's
		// self-report), and the helper's SID must own the detected account:
		// one Windows session can host processes under other credentials.
		return s.WinSessionVerified && s.WinSessionID == login.Session && callerOwnsLogin(s.IdentityKey, login.Username)
	}
	// Unix: the helper's peer UID is kernel-verified. Never compare loginctl
	// session ids with WinSessionID (which carries the UID on Unix).
	return s.UID == login.UID
}
