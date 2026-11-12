//go:build windows

package sessionbroker

import (
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// processTokenSID is the SID of this process's token: the identity the broker
// would verify for it. os/user is not used here because, running as SYSTEM
// on a domain member, it names the machine account (DOMAIN\HOST$) rather
// than the account the SID resolves to.
func processTokenSID(t *testing.T) string {
	t.Helper()
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		t.Fatalf("OpenCurrentProcessToken: %v", err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatalf("GetTokenUser: %v", err)
	}
	return user.User.Sid.String()
}

// The running account resolves from its SID to DOMAIN\account and back from
// DOMAIN\account in any case. A bare name follows Windows' lookup order: a
// local account of that name wins over a domain account.
func TestWindowsAccountNameFormsResolveToTheSameSID(t *testing.T) {
	sid := processTokenSID(t)
	full, err := platformAccountNameForIdentity(sid)
	if err != nil {
		t.Fatalf("platformAccountNameForIdentity(%s): %v", sid, err)
	}
	i := strings.LastIndex(full, `\`)
	if i <= 0 || i == len(full)-1 {
		t.Fatalf("account name %q is not DOMAIN\\account", full)
	}
	for _, form := range []string{full, strings.ToUpper(full), strings.ToLower(full)} {
		got, err := platformAccountIdentityForName(form)
		if err != nil {
			t.Fatalf("platformAccountIdentityForName(%q): %v", form, err)
		}
		if got != sid {
			t.Fatalf("platformAccountIdentityForName(%q) = %s, want %s", form, got, sid)
		}
	}

	bare := full[i+1:]
	want := sid
	if computer, err := windows.ComputerName(); err == nil {
		if local, err := platformAccountIdentityForName(computer + `\` + bare); err == nil {
			want = local // a local account with the same name
		}
	}
	got, err := platformAccountIdentityForName(bare)
	if err != nil {
		t.Fatalf("platformAccountIdentityForName(%q): %v", bare, err)
	}
	if got != want {
		t.Fatalf("platformAccountIdentityForName(%q) = %s, want %s", bare, got, want)
	}

	if _, err := platformAccountIdentityForName(`NO-SUCH-DOMAIN-7f3a\no-such-account-7f3a`); err == nil {
		t.Fatal("an unknown account resolved")
	}
}
