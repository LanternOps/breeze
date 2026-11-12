//go:build windows

package sessionbroker

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// platformAccountNameForIdentity returns DOMAIN\account for a SID, the same
// form the user helper reports for itself (NameSamCompatible). LookupAccountSid
// answers for signed-in domain accounts from the logon cache when no domain
// controller is reachable.
func platformAccountNameForIdentity(identity string) (string, error) {
	sid, err := windows.StringToSid(identity)
	if err != nil {
		return "", err
	}
	account, domain, _, err := sid.LookupAccount("")
	if err != nil {
		return "", classifyWindowsLookupError(err)
	}
	if account == "" {
		return "", fmt.Errorf("SID %s has no account name", identity)
	}
	if domain == "" {
		return account, nil
	}
	return domain + `\` + account, nil
}

// platformAccountIdentityForName resolves DOMAIN\account, account@domain or a
// bare account name (local accounts first, then the domain) to its SID.
func platformAccountIdentityForName(name string) (string, error) {
	sid, _, _, err := windows.LookupSID("", name)
	if err != nil {
		return "", classifyWindowsLookupError(err)
	}
	return sid.String(), nil
}
