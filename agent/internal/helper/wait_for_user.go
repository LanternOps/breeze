package helper

import (
	"runtime"
	"time"
)

// #10379: Assist is a desktop app for the person at the console. With nobody
// signed in there is no user to launch it as; launched as SYSTEM into the
// logon-screen session it exits 101, and counting those exits made the watcher
// give up and report crash_loop on an idle machine. "No signed-in user" is a
// wait: nothing launches, the crash count is left alone, one DEBUG line marks
// each change, and the next heartbeat (Apply) launches Assist once a user is
// signed in.
//
// Which sessions have a signed-in user is the platform enumerator's call
// (enumerator_*.go). On Windows: the console session per hasSignedInUser. On
// macOS and Linux the enumerators already list only non-root users' sessions
// (Linux also needs a display), so they never launch Assist with nobody signed
// in, and their spawn paths do not return ErrNoActiveSession.

const waitingForUserMsg = "breeze assist waiting for a signed-in user"

// userTokenGrace is how long Apply may find no user token for a session the
// enumerator lists before it says so at WARN. A short gap is normal (an Azure
// AD session whose explorer.exe has not started); a heartbeat apart, several
// tries fit inside it.
const userTokenGrace = 5 * time.Minute

const noUserTokenMsg = "breeze assist not started: no user token for the session's signed-in user"

// waitForSignedInUser enables the watcher's and Apply's enumerator-based wait.
// Windows only: macOS and Linux keep their existing watcher behaviour. A var so
// tests can exercise both on any host.
var waitForSignedInUser = runtime.GOOS == "windows"

// sessionHasSignedInUserLocked reports whether the enumerator still lists
// key as a session with a signed-in user. Off Windows, or with no enumerator,
// it answers true so the caller keeps its existing behaviour. Must be called
// with m.mu held.
func (m *Manager) sessionHasSignedInUserLocked(key string) bool {
	if !waitForSignedInUser || m.sessionEnumerator == nil {
		return true
	}
	for _, si := range m.sessionEnumerator.ActiveSessions() {
		if si.Key == key {
			return true
		}
	}
	return false
}

// noteWaitingForUserLocked records that Assist cannot launch in state's
// session because nobody is signed in, logging once per change. Must be
// called with m.mu held.
func (m *Manager) noteWaitingForUserLocked(state *sessionState, reason string) {
	if state.waitingForUser {
		return
	}
	state.waitingForUser = true
	log.Debug(waitingForUserMsg, "session", state.key, "reason", reason)
}

// noteNoUserTokenLocked records that Apply got ErrNoActiveSession for a session
// the enumerator lists. That is a wait like any other at first: the user may
// be signing out, or explorer.exe may not have started yet. If it lasts
// userTokenGrace it is not a wait for a sign-in any more, and with no other
// report (it is neither a crash nor an install issue) the operator would have
// nothing, so it is logged once at WARN, the level that ships to the server.
// Causes that fit include a replacement shell with no explorer.exe on a session
// WTSQueryUserToken refuses, or security software denying access to explorer's
// token; the strategy errors in err tell them apart. Must be called with m.mu
// held.
func (m *Manager) noteNoUserTokenLocked(state *sessionState, err error) {
	m.noteWaitingForUserLocked(state, err.Error())
	now := m.nowTime()
	if state.noTokenSince.IsZero() {
		state.noTokenSince = now
		return
	}
	if state.noTokenWarned || now.Sub(state.noTokenSince) < userTokenGrace {
		return
	}
	state.noTokenWarned = true
	log.Warn(noUserTokenMsg,
		"session", state.key,
		"waiting", now.Sub(state.noTokenSince).String(),
		"error", err.Error(),
	)
}

// noteUserPresentLocked ends a session's wait after a launch succeeded,
// logging the change. Must be called with m.mu held.
func (m *Manager) noteUserPresentLocked(state *sessionState) {
	if !state.waitingForUser {
		return
	}
	state.clearUserWait()
	log.Debug("signed-in user present; breeze assist launched", "session", state.key)
}

// noteSignedInSessionsLocked logs once when Apply finds no session with a
// signed-in user while Assist is deployed, and re-arms when one appears.
// Must be called with m.mu held.
func (m *Manager) noteSignedInSessionsLocked(count int, enabled bool) {
	if !waitForSignedInUser || count > 0 || !enabled {
		m.noSignedInUserLogged = false
		return
	}
	if m.noSignedInUserLogged {
		return
	}
	m.noSignedInUserLogged = true
	log.Debug(waitingForUserMsg, "reason", "no session with a signed-in user")
}
