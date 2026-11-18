package sessionbroker

// Admission of the Linux per-session desktop helper (#12117).
//
// The helper runs as the logged-in user, under a user manager that user
// fully controls, so every claim it makes is an assertion. What earns it the
// desktop scope is a single-use spawn ticket root minted for one logind
// session (linux_desktop_ticket.go), redeemed against the kernel uid, for an
// explicitly active, local, Wayland user session, by a peer running the very
// build the daemon runs. Untagged so the decisions are tested on every host.

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// linuxDesktopHelperScopes is the whole grant for an admitted Linux desktop
// helper. Not notify, clipboard, tray, run_as_user, consent or prompt
// scopes: none of that traffic is ever routed to this helper.
var linuxDesktopHelperScopes = []string{"desktop"}

// linuxDesktopLogindTimeout bounds the logind lookup during admission.
const linuxDesktopLogindTimeout = 2 * time.Second

// LogindSessionState is what admission needs to know about one logind
// session, read explicitly from logind (never from a list-row default).
type LogindSessionState struct {
	UID    uint32
	Type   string
	State  string
	Class  string
	Remote bool
	// Exists is false when logind does not know the session.
	Exists bool
	// PropertiesUnknown is true when any property above could not be read,
	// or the other-session count could not be established. Admission treats
	// it as a refusal.
	PropertiesUnknown bool
	// OtherGraphicalSessions counts the uid's other local graphical (x11,
	// wayland, mir) sessions. The user bus is shared between them, so a
	// helper in one of several is ambiguous; admission requires zero.
	OtherGraphicalSessions int
}

// logindLookupFunc reads one logind session. Nil means no lookup is
// available on this platform, and admission refuses.
type logindLookupFunc func(ctx context.Context, id string) (LogindSessionState, error)

// linuxDesktopAdmission is the first, pure gate. It reports whether this
// auth request is a Linux desktop helper that must go through ticket
// admission, and any permanent rejection. It never rejects on darwin or
// Windows, where these fields are not part of the protocol.
func linuxDesktopAdmission(goos string, role ipc.HelperRole, req ipc.AuthRequest) (isLinuxDesktop bool, reject string) {
	if goos != "linux" {
		return false, ""
	}
	if role == ipc.HelperRoleUser && req.BinaryKind == ipc.HelperBinaryDesktopHelper {
		// Never fall through to userHelperScopes, which include run_as_user.
		if req.SpawnTicket == "" {
			return false, "linux desktop helper requires a spawn ticket"
		}
		if req.LogindSessionID == "" {
			return false, "linux desktop helper requires a logind session"
		}
		return true, ""
	}
	if req.SpawnTicket != "" || req.LogindSessionID != "" {
		return false, "spawn ticket is only valid for a Linux desktop helper"
	}
	return false, ""
}

// linuxDesktopSessionLive reports whether logind's answer allows a helper
// bound to b. It fails closed on an incomplete answer.
func linuxDesktopSessionLive(st LogindSessionState, b LinuxDesktopBinding) (reason string, ok bool) {
	switch {
	case st.PropertiesUnknown:
		return "logind session state incomplete", false
	case !st.Exists:
		return "logind session not found", false
	case b.UID == 0 || st.UID != b.UID:
		return "logind session belongs to a different uid", false
	case st.Type != "wayland":
		return "logind session is not a Wayland session", false
	case st.State != "active":
		return "logind session is not active", false
	case st.Class != "user":
		return "logind session is not a user session", false
	case st.Remote:
		return "logind session is remote", false
	case st.OtherGraphicalSessions != 0:
		return "uid has more than one graphical session", false
	}
	return "", true
}

// IssueLinuxDesktopTicket mints a single-use spawn ticket for a helper root
// is about to start in binding's logind session. The nonce goes to that
// helper only, out of band; it is never logged.
func (b *Broker) IssueLinuxDesktopTicket(binding LinuxDesktopBinding) (string, error) {
	return b.linuxDesktopTickets.issue(binding)
}

// RevokeLinuxDesktopTickets drops any outstanding ticket for a logind
// session, e.g. when the session ends before its helper connected.
func (b *Broker) RevokeLinuxDesktopTickets(logindSessionID string) {
	b.linuxDesktopTickets.revokeSession(logindSessionID)
}

// runningBuildHash is the SHA-256 of the daemon's own executable, recorded
// when the broker started; "" if it could not be read.
func (b *Broker) runningBuildHash() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.selfExeHash
}

// admitLinuxDesktopHelper runs ticket admission for a peer that passed
// linuxDesktopAdmission and the binary path and hash checks. kernelUID is
// the SO_PEERCRED uid and peerHash the hash of the peer's kernel-resolved
// executable; nothing here reads the claimed uid. It returns the binding the
// session will carry, or a rejection reason.
func (b *Broker) admitLinuxDesktopHelper(kernelUID uint32, peerHash string, req ipc.AuthRequest) (LinuxDesktopBinding, string) {
	if kernelUID == 0 {
		return LinuxDesktopBinding{}, "linux desktop helper must not run as root"
	}
	// Same build as the daemon, not merely an allowlisted one: after a
	// self-update replaces the file on disk, a freshly spawned helper runs
	// the new build while root still runs the old one. Checked before the
	// ticket so a mismatched build does not burn it.
	if self := b.runningBuildHash(); self == "" || peerHash != self {
		return LinuxDesktopBinding{}, "linux desktop helper is not the running agent build"
	}
	if !validLogindSessionID(req.LogindSessionID) {
		return LinuxDesktopBinding{}, "linux desktop helper presented an invalid logind session id"
	}
	binding, err := b.linuxDesktopTickets.consume(req.SpawnTicket, req.LogindSessionID, kernelUID)
	if err != nil {
		return LinuxDesktopBinding{}, "linux desktop helper spawn ticket refused: " + err.Error()
	}
	lookup := b.linuxLogindLookup
	if lookup == nil {
		return LinuxDesktopBinding{}, "logind session state unavailable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), linuxDesktopLogindTimeout)
	defer cancel()
	st, err := lookup(ctx, binding.LogindSessionID)
	if err != nil {
		log.Warn("logind lookup failed during Linux desktop helper admission",
			"logindSession", binding.LogindSessionID, "uid", kernelUID, "error", err.Error())
		return LinuxDesktopBinding{}, "logind session state unavailable"
	}
	if reason, ok := linuxDesktopSessionLive(st, binding); !ok {
		return LinuxDesktopBinding{}, reason
	}
	return binding, ""
}

// isLinuxDesktopSession reports whether s is an admitted Linux desktop
// helper. Such a session takes desktop traffic only; per-user routing that
// selects by role rather than scope must skip it.
func isLinuxDesktopSession(s *Session) bool {
	return s != nil && s.LinuxDesktop != nil
}

// parseLogindShowSession reads `loginctl show-session <id>
// --property=Id,User,Type,State,Class,Remote` output. A property that is
// missing or unreadable marks the result PropertiesUnknown.
func parseLogindShowSession(id, out string) LogindSessionState {
	props := parseKeyValueLines(out)
	st := LogindSessionState{}
	gotID, hasID := props["Id"]
	st.Exists = hasID && gotID == id
	user, hasUser := props["User"]
	uid, uidErr := strconv.ParseUint(user, 10, 32)
	typ, hasType := props["Type"]
	state, hasState := props["State"]
	class, hasClass := props["Class"]
	remote, hasRemote := props["Remote"]
	if !hasID || !hasUser || uidErr != nil || !hasType || !hasState || !hasClass || !hasRemote ||
		(remote != "yes" && remote != "no") {
		st.PropertiesUnknown = true
	}
	if uidErr == nil {
		st.UID = uint32(uid)
	}
	st.Type, st.State, st.Class, st.Remote = typ, state, class, remote == "yes"
	return st
}

// maxLogindUserSessions bounds how many sessions of one uid admission will
// inspect. A uid with more is refused as ambiguous anyway.
const maxLogindUserSessions = 32

// parseLogindUserSessions reads `loginctl show-user <uid>
// --property=Sessions` output. ok is false when the property is missing,
// lists an id of an unexpected shape, or lists too many sessions.
func parseLogindUserSessions(out string) (ids []string, ok bool) {
	raw, has := parseKeyValueLines(out)["Sessions"]
	if !has {
		return nil, false
	}
	ids = strings.Fields(raw)
	if len(ids) > maxLogindUserSessions {
		return nil, false
	}
	for _, id := range ids {
		if !validLogindSessionID(id) {
			return nil, false
		}
	}
	return ids, true
}

// isLocalGraphicalLogindSession reads `loginctl show-session <id>
// --property=Type,Remote` output for another session of the same uid.
func isLocalGraphicalLogindSession(out string) (graphical, ok bool) {
	props := parseKeyValueLines(out)
	typ, hasType := props["Type"]
	remote, hasRemote := props["Remote"]
	if !hasType || !hasRemote {
		return false, false
	}
	switch typ {
	case "x11", "wayland", "mir":
		return remote != "yes", true
	}
	return false, true
}

func parseKeyValueLines(out string) map[string]string {
	props := make(map[string]string)
	for _, line := range strings.Split(out, "\n") {
		k, v, found := strings.Cut(strings.TrimSpace(line), "=")
		if !found || k == "" {
			continue
		}
		props[k] = v
	}
	return props
}
