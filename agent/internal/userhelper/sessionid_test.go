package userhelper

import (
	"fmt"
	"os"
	"os/user"
	"regexp"
	"strings"
	"testing"
)

// opaqueSessionIDRe is the whole contract: "helper-" plus exactly 16 lowercase
// hex characters and nothing else. It is anchored on purpose — re-introducing
// any interpolated identity ("helper-CONTOSO\jdoe-6412") or even a trailing PID
// ("helper-<hex>-6412") fails the anchor rather than sliding through.
var opaqueSessionIDRe = regexp.MustCompile(`^helper-[0-9a-f]{16}$`)

func TestNewSessionIDIsOpaque(t *testing.T) {
	id := newSessionID()
	if !opaqueSessionIDRe.MatchString(id) {
		t.Fatalf("session id %q is not an opaque helper id (want %s)", id, opaqueSessionIDRe)
	}
}

// TestNewSessionIDCarriesNoHostIdentity is the #3109 regression: the id must not
// embed the OS login name, the machine account, the hostname, or the PID. Those
// values reach the API inside free-text error strings where key-name redaction
// cannot see them.
func TestNewSessionIDCarriesNoHostIdentity(t *testing.T) {
	// Identity strings the OLD constructor (fmt.Sprintf("helper-%s-%d",
	// username, os.Getpid())) would have embedded. Every one contains a
	// character outside [0-9a-f], so none can appear inside 16 random hex
	// characters by chance — these assertions cannot flake.
	leaks := []string{
		`CONTOSO\jdoe`,
		`CONTOSO\WKSTN-01$`,
		`WKSTN-01$`,
		"jane.doe",
		"todd-macbook.local",
	}
	for _, id := range generateIDs(t, 256) {
		for _, leak := range leaks {
			if strings.Contains(id, leak) {
				t.Fatalf("session id %q embeds host identity %q", id, leak)
			}
		}
	}

	// Control: the pre-#3109 constructor's output must FAIL the grammar these
	// assertions rely on. Without this, a grammar that happened to match
	// everything would let every check in this file pass vacuously.
	legacy := fmt.Sprintf("helper-%s-%d", `CONTOSO\\WKSTN-01$`, os.Getpid())
	if opaqueSessionIDRe.MatchString(legacy) {
		t.Fatalf("grammar %s does not discriminate: it matches the legacy id %q", opaqueSessionIDRe, legacy)
	}

	id := newSessionID()

	// The live username must not appear. Same guard: only meaningful when the
	// username contains a character that cannot occur in the hex body — which
	// is always true for the Windows `DOMAIN\user` form this issue is about.
	if u, err := user.Current(); err == nil && u.Username != "" && containsNonHexLower(u.Username) {
		if strings.Contains(id, u.Username) {
			t.Fatalf("session id %q embeds the current username %q", id, u.Username)
		}
	}
	if host, err := os.Hostname(); err == nil && host != "" && containsNonHexLower(host) {
		if strings.Contains(id, host) {
			t.Fatalf("session id %q embeds the hostname %q", id, host)
		}
	}
}

// TestNewSessionIDIsUniquePerCall pins the reconnect property: the broker
// rejects an auth whose SessionID is already registered ("session ID already in
// use"), so a helper re-authenticating while its previous session is still held
// must not present the same id. The old username+PID id was a pure function of
// the process and collided with itself; a random one cannot.
func TestNewSessionIDIsUniquePerCall(t *testing.T) {
	const n = 2000
	seen := make(map[string]struct{}, n)
	for _, id := range generateIDs(t, n) {
		if _, dup := seen[id]; dup {
			t.Fatalf("newSessionID returned a duplicate id %q within %d calls", id, n)
		}
		seen[id] = struct{}{}
	}
}

func generateIDs(t *testing.T, n int) []string {
	t.Helper()
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		id := newSessionID()
		if !opaqueSessionIDRe.MatchString(id) {
			t.Fatalf("session id %q is not an opaque helper id (want %s)", id, opaqueSessionIDRe)
		}
		ids = append(ids, id)
	}
	return ids
}

func containsNonHexLower(s string) bool {
	return strings.ContainsFunc(s, func(r rune) bool {
		return !strings.ContainsRune("0123456789abcdef", r)
	})
}
