//go:build !windows

package collectors

// principalForSession reports the numeric uid of a Unix session. No UPN is
// ever synthesized: a Unix username — even an email-shaped one — is not
// directory evidence, so the API will never create a binding from it.
func principalForSession(username, _ string, uid uint32) *SessionPrincipal {
	return &SessionPrincipal{UID: &uid, Username: username}
}
