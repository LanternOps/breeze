//go:build linux

package sessionbroker

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"testing"
)

// fakeGetent installs a getent that answers like NSS for one directory
// account that /etc/passwd does not list.
func fakeGetent(t *testing.T, entry string) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "getent")
	body := "#!/bin/sh\n" +
		"[ \"$1\" = passwd ] || exit 2\n" +
		"case \"$2\" in\n" +
		"  dir.user|4242) echo '" + entry + "' ;;\n" +
		"  *) exit 2 ;;\n" +
		"esac\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	prev := getentPaths
	getentPaths = []string{filepath.Join(dir, "missing"), script}
	t.Cleanup(func() { getentPaths = prev })
}

// Directory accounts (LDAP, AD, SSSD) are not in /etc/passwd, which is all
// os/user reads in a build without cgo; they resolve through NSS.
func TestDirectoryAccountsResolveThroughNSS(t *testing.T) {
	if _, err := user.LookupId("4242"); err == nil {
		t.Skip("uid 4242 exists in the local account database")
	}
	fakeGetent(t, "dir.user:*:4242:4242:Directory User:/home/dir.user:/bin/bash")

	if name, err := platformAccountNameForIdentity("4242"); err != nil || name != "dir.user" {
		t.Fatalf("platformAccountNameForIdentity(4242) = %q, %v; want dir.user", name, err)
	}
	if uid, err := platformAccountIdentityForName("dir.user"); err != nil || uid != "4242" {
		t.Fatalf("platformAccountIdentityForName(dir.user) = %q, %v; want 4242", uid, err)
	}
	if _, err := platformAccountNameForIdentity("4343"); err == nil {
		t.Fatal("an unknown uid resolved")
	}
}

func TestDirectoryAnswerMustMatchTheQuery(t *testing.T) {
	if _, err := user.LookupId("4242"); err == nil {
		t.Skip("uid 4242 exists in the local account database")
	}
	// An entry for a different account than the one asked about is refused.
	fakeGetent(t, "someone:*:5000:5000::/home/someone:/bin/sh")
	if name, err := platformAccountNameForIdentity("4242"); err == nil {
		t.Fatalf("uid 4242 resolved to %q from an entry for uid 5000", name)
	}
	if uid, err := platformAccountIdentityForName("dir.user"); err == nil {
		t.Fatalf("dir.user resolved to %q from an entry for someone", uid)
	}
}

func TestParsePasswdEntry(t *testing.T) {
	name, uid, err := parsePasswdEntry("alice:x:1001:1001:Alice:/home/alice:/bin/bash\nignored\n")
	if err != nil || name != "alice" || uid != "1001" {
		t.Fatalf("parsePasswdEntry = %q, %q, %v", name, uid, err)
	}
	for _, bad := range []string{"", "alice", "alice:x::1001:A:/h:/s", ":x:1:1:a:/h:/s"} {
		if _, _, err := parsePasswdEntry(bad); err == nil {
			t.Fatalf("parsePasswdEntry(%q) accepted a malformed entry", bad)
		}
	}
}

// The real getent answers for the running account by name and by UID.
func TestSystemAccountEntryUsesGetent(t *testing.T) {
	found := false
	for _, p := range getentPaths {
		if _, err := os.Stat(p); err == nil {
			found = true
		}
	}
	if !found {
		t.Skip("getent is not installed")
	}
	uid := strconv.Itoa(os.Getuid())
	name, gotUID, err := systemAccountEntry(uid)
	if err != nil || name == "" || gotUID != uid {
		t.Fatalf("systemAccountEntry(%s) = %q, %q, %v", uid, name, gotUID, err)
	}
	byName, byNameUID, err := systemAccountEntry(name)
	if err != nil || byName != name || byNameUID != uid {
		t.Fatalf("systemAccountEntry(%q) = %q, %q, %v", name, byName, byNameUID, err)
	}
}
