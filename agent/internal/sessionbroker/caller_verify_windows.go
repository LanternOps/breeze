//go:build windows

package sessionbroker

import (
	"strings"

	"golang.org/x/sys/windows"
)

// callerOwnsLoginOS resolves the helper's kernel-verified SID to its account
// and compares it with the WTS username of the console login. WTS reports the
// bare account name, so both the bare and DOMAIN\account forms are accepted.
func callerOwnsLoginOS(identityKey, username string) bool {
	if strings.TrimSpace(username) == "" {
		return false
	}
	sid, err := windows.StringToSid(identityKey)
	if err != nil {
		return false
	}
	account, domain, _, err := sid.LookupAccount("")
	if err != nil || account == "" {
		return false
	}
	if strings.EqualFold(account, username) {
		return true
	}
	return domain != "" && strings.EqualFold(domain+`\`+account, username)
}
