//go:build windows

package sessionbroker

import (
	"os/user"
	"strings"
	"testing"
)

// The account running the test resolves from its SID to DOMAIN\account, and
// back from DOMAIN\account in any case and from the bare account name.
func TestWindowsAccountNameFormsResolveToTheSameSID(t *testing.T) {
	cu, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}
	full, err := platformAccountNameForIdentity(cu.Uid)
	if err != nil {
		t.Fatalf("platformAccountNameForIdentity(%s): %v", cu.Uid, err)
	}
	if !strings.EqualFold(full, cu.Username) {
		t.Fatalf("platformAccountNameForIdentity(%s) = %q, want %q", cu.Uid, full, cu.Username)
	}
	i := strings.LastIndex(full, `\`)
	if i < 0 {
		t.Fatalf("account name %q is not DOMAIN\\account", full)
	}
	for _, form := range []string{full, strings.ToUpper(full), strings.ToLower(full), full[i+1:]} {
		sid, err := platformAccountIdentityForName(form)
		if err != nil {
			t.Fatalf("platformAccountIdentityForName(%q): %v", form, err)
		}
		if sid != cu.Uid {
			t.Fatalf("platformAccountIdentityForName(%q) = %s, want %s", form, sid, cu.Uid)
		}
	}
	if _, err := platformAccountIdentityForName(`NO-SUCH-DOMAIN-7f3a\no-such-account-7f3a`); err == nil {
		t.Fatal("an unknown account resolved")
	}
}
