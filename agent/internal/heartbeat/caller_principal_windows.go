//go:build windows

package heartbeat

import (
	"strings"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// principalForCaller reports the helper's kernel-verified SID, after
// re-checking that it still owns the detected console login. The UPN comes
// from the OS account translation, never from the helper or a contact email.
func principalForCaller(s *sessionbroker.Session, loginUsername string) *callerPrincipal {
	if s == nil || strings.TrimSpace(loginUsername) == "" {
		return nil
	}
	sid, err := windows.StringToSid(s.IdentityKey)
	if err != nil {
		return nil
	}
	account, domain, _, err := sid.LookupAccount("")
	if err != nil || account == "" {
		return nil
	}
	canonical := account
	if domain != "" {
		canonical = domain + `\` + account
	}
	if !strings.EqualFold(loginUsername, account) && !strings.EqualFold(loginUsername, canonical) {
		return nil
	}
	p := &callerPrincipal{SID: sid.String(), Username: loginUsername}
	if upn, err := windows.TranslateAccountName(canonical, windows.NameSamCompatible, windows.NameUserPrincipal, 256); err == nil {
		p.UPN = upn
	}
	return p
}
