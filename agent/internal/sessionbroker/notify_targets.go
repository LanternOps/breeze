package sessionbroker

import (
	"sort"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// notifyGroupKey identifies the SCREEN a notify-scoped helper draws on.
//
// Two helpers that share a Windows session id share one desktop, one taskbar and
// one signed-in human, so a notification fanned out to both is drawn twice
// (#4940). A helper whose Windows session id is unknown gets a key of its own and
// is therefore never merged with anything: on Linux and macOS every helper
// reports the "0" the non-Windows currentWinSessionID stub returns, and grouping
// on that would collapse a host with several logged-in users down to a single
// warning. "0" is already this repo's sentinel for "no interactive session
// known" — ConsoleSessionID normalizes it to "" and every consumer fails closed
// on the empty value — so treating it as ungroupable is the same convention.
func notifyGroupKey(s *Session) string {
	if id := s.WinSessionID; id != "" && id != "0" {
		return "win:" + id
	}
	return "session:" + s.SessionID
}

// betterNotifyTarget reports whether candidate should draw the notification
// instead of current. The user-role helper wins because it runs AS the signed-in
// user, so the dialog belongs to the person who has to act on it; the system-role
// helper draws into the same session from the SYSTEM account and is the fallback
// for a session with no user token (the logon screen, or a disconnected RDP
// session that retained its SYSTEM helper).
//
// The tie-break reads ConnectedAt and SessionID only, both written once in
// NewSession and never mutated, rather than reusing betterSession: betterSession
// also compares LastSeen, which Touch() rewrites under s.mu on every inbound
// message. Nothing calls this with two same-role helpers in one session —
// admission already refuses a duplicate HelperKey — so the tie-break exists for
// determinism, and it may as well be lock-free.
func betterNotifyTarget(candidate, current *Session) bool {
	if current == nil {
		return true
	}
	candidateUser := candidate.HelperRole == ipc.HelperRoleUser
	currentUser := current.HelperRole == ipc.HelperRoleUser
	if candidateUser != currentUser {
		return candidateUser
	}
	if !candidate.ConnectedAt.Equal(current.ConnectedAt) {
		return candidate.ConnectedAt.After(current.ConnectedAt)
	}
	return candidate.SessionID < current.SessionID
}

// selectNotifyTargets reduces a set of notify-scoped sessions to at most one per
// interactive Windows session, sorted by session id so callers and log lines are
// deterministic even though b.sessions is a map. The input slice is returned
// unchanged when it holds fewer than two sessions or when nothing was merged.
func selectNotifyTargets(sessions []*Session) []*Session {
	if len(sessions) < 2 {
		return sessions
	}

	best := make(map[string]*Session, len(sessions))
	for _, s := range sessions {
		key := notifyGroupKey(s)
		if betterNotifyTarget(s, best[key]) {
			best[key] = s
		}
	}
	if len(best) == len(sessions) {
		return sessions
	}

	chosen := make(map[*Session]struct{}, len(best))
	for _, s := range best {
		chosen[s] = struct{}{}
	}
	targets := make([]*Session, 0, len(chosen))
	for _, s := range sessions {
		if _, ok := chosen[s]; ok {
			targets = append(targets, s)
		}
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].SessionID < targets[j].SessionID })
	return targets
}

// notifyTargets returns the sessions that should each render ONE copy of a
// notification: every connected session holding the "notify" scope, de-duplicated
// to one helper per Windows session.
//
// The scope filter is the one BroadcastNotification and
// RequestNotificationDecision have always applied and must keep applying (#3255):
// the assist helper and the watchdog have no TypeNotify handler at all.
func (b *Broker) notifyTargets() []*Session {
	b.mu.RLock()
	scoped := make([]*Session, 0, len(b.sessions))
	for _, s := range b.sessions {
		if s.HasScope("notify") {
			scoped = append(scoped, s)
		}
	}
	b.mu.RUnlock()

	targets := selectNotifyTargets(scoped)
	if len(targets) < len(scoped) {
		// Debug, not Warn: this is the fix working, and it happens on every rung
		// of the reboot ladder on an always-on Windows host. It is logged because
		// "why did only one of my two helpers get the prompt" is otherwise an
		// unanswerable question from the log alone.
		log.Debug("notify fan-out collapsed to one helper per Windows session",
			"notifyScopedSessions", len(scoped),
			"targetedSessions", len(targets),
		)
	}
	return targets
}
