//go:build windows

package collectors

import (
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
)

// principalForSession reads the authenticated identity of a Windows session
// from its logon token (WTSQueryUserToken), never from the caller-supplied
// username. The bare WTS username is only used as a consistency check: when
// the token's account does not match it, no principal is reported at all.
// UPN translation is best-effort — a local account has none, and the
// binding logic treats a missing UPN as "no directory evidence".
func principalForSession(username, session string, _ uint32) *SessionPrincipal {
	id, err := strconv.ParseUint(session, 10, 32)
	if err != nil {
		return nil
	}
	var token windows.Token
	if windows.WTSQueryUserToken(uint32(id), &token) != nil {
		return nil
	}
	defer token.Close()
	u, err := token.GetTokenUser()
	if err != nil {
		return nil
	}
	account, domain, _, err := u.User.Sid.LookupAccount("")
	if err != nil {
		return nil
	}
	canonical := account
	if domain != "" {
		canonical = domain + `\` + account
	}
	// WTSUserName supplies an unqualified name; the token still comes from
	// this session, so both spellings are acceptable.
	if !strings.EqualFold(account, username) && !strings.EqualFold(canonical, username) {
		return nil
	}
	p := &SessionPrincipal{SID: u.User.Sid.String(), Username: username}
	if upn, err := windows.TranslateAccountName(canonical, windows.NameSamCompatible, windows.NameUserPrincipal, 256); err == nil {
		p.UPN = upn
	}
	return p
}
