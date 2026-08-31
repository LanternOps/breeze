package pamactuator

import (
	"errors"
	"strings"
)

// invalidSessionID is the WTS sentinel for "no session" (0xFFFFFFFF, returned
// by WTSGetActiveConsoleSessionId when there is no console session).
const invalidSessionID uint32 = 0xFFFFFFFF

// resolveSubjectSessionWith implements the token_launch session-resolution
// precedence, with the platform-specific lookups injected so the precedence is
// unit-testable off-Windows (the real lookups are Win32 syscalls):
//
//  1. an explicit SubjectSessionID from ETW discovery, when valid (non-zero and
//     not the WTS sentinel) — reserved seam, currently never populated;
//  2. else resolve SubjectUsername to a live interactive session by name;
//  3. else fall back to the physical console session.
//
// The returned source string records which branch won, for the caller to log.
// A username that matches no live session falls through to the console — the
// remote actuate path may reference a user who has since logged off, and
// landing on the console is a safer default than failing the elevation.
func resolveSubjectSessionWith(
	req Request,
	userLookup func(string) (uint32, bool),
	console func(Request) (uint32, error),
) (uint32, string, error) {
	if req.SubjectSessionID != 0 && req.SubjectSessionID != invalidSessionID {
		return req.SubjectSessionID, "etw_session", nil
	}
	if req.SubjectUsername != "" && userLookup != nil {
		if id, ok := userLookup(req.SubjectUsername); ok {
			return id, "username_lookup", nil
		}
	}
	id, err := console(req)
	return id, "console_fallback", err
}

// resolveSubjectSessionStrictWith binds a v2 suspended launch to the live
// session resolved for its named subject. It deliberately ignores console and
// unverified numeric-session fallbacks: absence of the named subject fails
// closed instead of launching into another user's desktop.
func resolveSubjectSessionStrictWith(req Request, userLookup func(string) (uint32, bool)) (uint32, string, error) {
	if strings.TrimSpace(req.SubjectUsername) == "" || userLookup == nil {
		return 0, "subject_session_required", errors.New("PAM subject session is required")
	}
	if id, ok := userLookup(req.SubjectUsername); ok && id != 0 && id != invalidSessionID {
		return id, "username_lookup", nil
	}
	return 0, "subject_session_required", errors.New("PAM subject has no active interactive session")
}

// bareUsername strips a DOMAIN\ (or MACHINE\) prefix and any @realm UPN suffix,
// returning the trimmed bare account name. The subject username reaches us as
// LookupAccount output (DOMAIN\user) or a server-echoed value, while
// WTSQuerySessionInformation(WTSUserName) yields the bare name — so both sides
// are normalized to the bare name before a case-insensitive compare.
func bareUsername(u string) string {
	if i := strings.LastIndex(u, `\`); i >= 0 {
		u = u[i+1:]
	}
	if i := strings.Index(u, "@"); i >= 0 {
		u = u[:i]
	}
	return strings.TrimSpace(u)
}
