package sessionbroker

import (
	"errors"
	"fmt"
	"os/user"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

var errNoDirectory = fmt.Errorf("test directory: %w", errAccountDirectoryUnavailable)

// fakeAccounts resolves names through byName (name -> identity key) and the
// reverse; a nil map makes every lookup fail, as when the directory that
// holds the account cannot be reached.
func fakeAccounts(byName map[string]string, calls *int) *accountDirectory {
	return &accountDirectory{
		identityForName: func(name string) (string, error) {
			if calls != nil {
				*calls++
			}
			if id, ok := byName[name]; ok {
				return id, nil
			}
			return "", errNoDirectory
		},
		nameForIdentity: func(identity string) (string, error) {
			for name, id := range byName {
				if id == identity {
					return name, nil
				}
			}
			return "", errNoDirectory
		},
	}
}

func accountSession(id, identity, name string, role ipc.HelperRole, lastSeen time.Time) *Session {
	s := NewSession(nil, 0, identity, name, "", id, nil)
	s.accountIdentity = identity
	s.HelperRole = role
	s.LastSeen = lastSeen
	return s
}

func accountBroker(goos string, accounts *accountDirectory, sessions ...*Session) *Broker {
	b := &Broker{
		goos:       goos,
		accounts:   accounts,
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	for _, s := range sessions {
		b.sessions[s.SessionID] = s
	}
	return b
}

func TestSessionForUserMatchesTheAccountIdentityTheNameResolvesTo(t *testing.T) {
	now := time.Now()
	alice := accountSession("alice-helper", "1001", "alice", ipc.HelperRoleUser, now.Add(-time.Hour))
	// A session whose recorded name equals the requested one but that runs as
	// another account is never selected for that name.
	other := accountSession("other-helper", "1002", "alice", ipc.HelperRoleUser, now)
	b := accountBroker("linux", fakeAccounts(map[string]string{"alice": "1001", "bob": "1002"}, nil), alice, other)

	if got := b.SessionForUser("alice"); got != alice {
		t.Fatalf("SessionForUser(alice) = %v, want the session running as uid 1001", got)
	}
	if got := b.SessionForUser(" alice "); got != alice {
		t.Fatalf("SessionForUser with surrounding spaces = %v, want alice's session", got)
	}
	if got := b.SessionForUser("bob"); got != other {
		t.Fatalf("SessionForUser(bob) = %v, want the session running as uid 1002", got)
	}
	if got := b.SessionForUser("carol"); got != nil {
		t.Fatalf("SessionForUser(carol) = %v, want nil for an account with no session", got)
	}
}

func TestSessionForUserPrefersUserRoleAndSkipsAgentInternalRoles(t *testing.T) {
	now := time.Now()
	accounts := fakeAccounts(map[string]string{"alice": "1001", "root": "0"}, nil)

	assist := accountSession("assist", "1001", "alice", ipc.HelperRoleAssist, now)
	user := accountSession("user", "1001", "alice", ipc.HelperRoleUser, now.Add(-time.Hour))
	b := accountBroker("linux", accounts, assist, user)
	if got := b.SessionForUser("alice"); got != user {
		t.Fatalf("SessionForUser(alice) = %v, want the user-role helper", got)
	}

	b = accountBroker("linux", accounts, assist)
	if got := b.SessionForUser("alice"); got != assist {
		t.Fatalf("SessionForUser(alice) = %v, want the account's assist helper when no user-role helper is connected", got)
	}

	watchdog := accountSession("watchdog", "0", "root", ipc.HelperRoleWatchdog, now)
	backup := accountSession("backup", "0", "root", backupipc.HelperRoleBackup, now)
	b = accountBroker("linux", accounts, watchdog, backup)
	if got := b.SessionForUser("root"); got != nil {
		t.Fatalf("SessionForUser(root) = %v, want nil: watchdog and backup sessions never take per-user work", got)
	}
}

func TestSessionForUserFallsBackToVerifiedAccountNames(t *testing.T) {
	now := time.Now()
	corpAlice := accountSession("corp-alice", "S-1-5-21-10-20-30-1104", `CORP\alice`, ipc.HelperRoleUser, now)
	// The directory is unreachable: names are matched against the account
	// names resolved from each session's verified identity.
	b := accountBroker("windows", fakeAccounts(nil, nil), corpAlice)
	for _, name := range []string{`CORP\alice`, `corp\ALICE`, "alice", "Alice"} {
		if got := b.SessionForUser(name); got != corpAlice {
			t.Fatalf("SessionForUser(%q) = %v, want CORP\\alice's session", name, got)
		}
	}
	for _, name := range []string{`OTHER\alice`, "alic", `CORP\alice2`} {
		if got := b.SessionForUser(name); got != nil {
			t.Fatalf("SessionForUser(%q) = %v, want nil", name, got)
		}
	}

	// A bare name that two different accounts share is never guessed.
	localAlice := accountSession("pc-alice", "S-1-5-21-40-50-60-1001", `PC\alice`, ipc.HelperRoleUser, now)
	b = accountBroker("windows", fakeAccounts(nil, nil), corpAlice, localAlice)
	if got := b.SessionForUser("alice"); got != nil {
		t.Fatalf("SessionForUser(alice) = %v, want nil when two accounts share the bare name", got)
	}
	if got := b.SessionForUser(`pc\alice`); got != localAlice {
		t.Fatalf(`SessionForUser(pc\alice) = %v, want PC\alice's session`, got)
	}

	// Unix account names are case-sensitive and never domain-qualified.
	unixAlice := accountSession("unix-alice", "1001", "alice", ipc.HelperRoleUser, now)
	b = accountBroker("linux", fakeAccounts(nil, nil), unixAlice)
	if got := b.SessionForUser("alice"); got != unixAlice {
		t.Fatalf("SessionForUser(alice) = %v, want alice's session", got)
	}
	if got := b.SessionForUser("Alice"); got != nil {
		t.Fatalf("SessionForUser(Alice) = %v, want nil on Unix", got)
	}

	// A session whose account name could not be resolved is reachable only
	// through the directory.
	unnamed := accountSession("unnamed", "1003", "", ipc.HelperRoleUser, now)
	b = accountBroker("linux", fakeAccounts(nil, nil), unnamed)
	if got := b.SessionForUser(""); got != nil {
		t.Fatalf("SessionForUser(\"\") = %v, want nil", got)
	}
}

func TestSessionForUserRefusesMalformedNamesWithoutLookup(t *testing.T) {
	calls := 0
	b := accountBroker("linux", fakeAccounts(map[string]string{"alice": "1001"}, &calls),
		accountSession("alice", "1001", "alice", ipc.HelperRoleUser, time.Now()))
	for _, name := range []string{"", "   ", "-alice", "al\x00ice", "al\nice", strings.Repeat("a", maxAccountNameLen+1)} {
		if got := b.SessionForUser(name); got != nil {
			t.Fatalf("SessionForUser(%q) = %v, want nil", name, got)
		}
	}
	if calls != 0 {
		t.Fatalf("malformed names reached the account lookup %d times", calls)
	}
}

func TestPeerAccountNameComesFromTheVerifiedIdentity(t *testing.T) {
	b := accountBroker("linux", fakeAccounts(map[string]string{"alice": "1001"}, nil))
	if got := b.peerAccountName("1001"); got != "alice" {
		t.Fatalf("peerAccountName(1001) = %q, want alice", got)
	}
	if got := b.peerAccountName("1002"); got != "" {
		t.Fatalf("peerAccountName(1002) = %q, want empty when the identity has no account", got)
	}

	// A lookup that does not answer in time leaves the name empty rather
	// than holding the connection.
	release := make(chan struct{})
	defer close(release)
	b.accounts = &accountDirectory{
		nameForIdentity: func(string) (string, error) { <-release; return "late", nil },
		identityForName: func(string) (string, error) { <-release; return "1001", nil },
	}
	b.lookupTimeout = 50 * time.Millisecond
	start := time.Now()
	if got := b.peerAccountName("1001"); got != "" {
		t.Fatalf("peerAccountName with a stalled lookup = %q, want empty", got)
	}
	if b.SessionForUser("alice") != nil {
		t.Fatal("SessionForUser with a stalled lookup and no named session selected one")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("stalled lookups took %v", elapsed)
	}
}

// The platform lookups answer for the account running this test, in both
// directions.
func TestPlatformAccountLookupRoundTrip(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Skipf("user.Current: %v", err)
	}
	name, err := platformAccounts.nameForIdentity(current.Uid)
	if err != nil || name == "" {
		t.Fatalf("nameForIdentity(%q) = %q, %v", current.Uid, name, err)
	}
	identity, err := platformAccounts.identityForName(name)
	if err != nil {
		t.Fatalf("identityForName(%q): %v", name, err)
	}
	if identity != current.Uid {
		t.Fatalf("identityForName(%q) = %q, want %q", name, identity, current.Uid)
	}
}

// directoryAnswering returns a directory whose name lookups all fail with err
// and whose identity lookups answer from byIdentity.
func directoryAnswering(err error, byIdentity map[string]string) *accountDirectory {
	return &accountDirectory{
		identityForName: func(string) (string, error) { return "", err },
		nameForIdentity: func(identity string) (string, error) {
			if name, ok := byIdentity[identity]; ok {
				return name, nil
			}
			return "", errAccountNotFound
		},
	}
}

// The connected-session names stand in for the directory only when it
// cannot answer; when it answers that the account does not exist, no
// session is selected.
func TestSessionForUserTrustsADirectoryThatAnswersNoSuchAccount(t *testing.T) {
	now := time.Now()
	alice := accountSession("alice", "S-1-5-21-10-20-30-1104", `CORP\alice`, ipc.HelperRoleUser, now)

	// A failure not known to be transient is treated the same way.
	for _, err := range []error{errAccountNotFound, fmt.Errorf("lookup alice: %w", errAccountNotFound), errors.New("unclassified failure")} {
		b := accountBroker("windows", directoryAnswering(err, nil), alice)
		if got := b.SessionForUser(`CORP\alice`); got != nil {
			t.Fatalf("directory answered %v, SessionForUser selected %q", err, got.SessionID)
		}
	}

	// Unreachable directory, transient failure, or no answer in time: the
	// session names resolved at admission are used.
	b := accountBroker("windows", directoryAnswering(errNoDirectory, nil), alice)
	if got := b.SessionForUser(`CORP\alice`); got != alice {
		t.Fatalf("with the directory unavailable, SessionForUser = %v, want alice's session", got)
	}
	release := make(chan struct{})
	defer close(release)
	b = accountBroker("windows", &accountDirectory{
		identityForName: func(string) (string, error) { <-release; return "", errAccountNotFound },
		nameForIdentity: func(string) (string, error) { return "", errAccountNotFound },
	}, alice)
	b.lookupTimeout = 20 * time.Millisecond
	if got := b.SessionForUser("alice"); got != alice {
		t.Fatalf("with a stalled lookup, SessionForUser = %v, want alice's session", got)
	}
}

func TestWindowsLookupErrorsAreClassified(t *testing.T) {
	if err := classifyWindowsLookupError(winErrorNoneMapped); !errors.Is(err, errAccountNotFound) || directoryCouldNotAnswer(err) {
		t.Fatalf("ERROR_NONE_MAPPED: %v", err)
	}
	for _, errno := range []syscall.Errno{winErrorNoLogonServers, winRPCServerUnavailable, winErrorTrustedRelationFailure, winErrorDCNotFound} {
		if err := classifyWindowsLookupError(errno); !directoryCouldNotAnswer(err) {
			t.Fatalf("errno %d: %v, want directory unavailable", errno, err)
		}
	}
	if err := classifyWindowsLookupError(syscall.Errno(5)); directoryCouldNotAnswer(err) || errors.Is(err, errAccountNotFound) {
		t.Fatalf("ERROR_ACCESS_DENIED classified: %v", err)
	}
}

// On Windows the SYSTEM-role helper runs as SYSTEM in each interactive
// session; it never acts for a named account, so no name selects it,
// including names that resolve to SYSTEM.
func TestSessionForUserNeverSelectsTheWindowsSystemHelper(t *testing.T) {
	now := time.Now()
	accounts := fakeAccounts(map[string]string{
		"SYSTEM":              "S-1-5-18",
		`NT AUTHORITY\SYSTEM`: "S-1-5-18",
		"LocalSystem":         "S-1-5-18",
		`CORP\alice`:          "S-1-5-21-10-20-30-1104",
	}, nil)
	system := accountSession("system-1", "S-1-5-18", `NT AUTHORITY\SYSTEM`, ipc.HelperRoleSystem, now)
	system.AllowedScopes = []string{"notify", "tray", "desktop"}
	b := accountBroker("windows", accounts, system)
	for _, name := range []string{"SYSTEM", `NT AUTHORITY\SYSTEM`, "LocalSystem", "system"} {
		if got := b.SessionForUser(name); got != nil {
			t.Fatalf("SessionForUser(%q) selected the SYSTEM helper %q", name, got.SessionID)
		}
	}
	// A user's helper in the same Windows session is still found.
	alice := accountSession("alice-1", "S-1-5-21-10-20-30-1104", `CORP\alice`, ipc.HelperRoleUser, now.Add(-time.Hour))
	b = accountBroker("windows", accounts, system, alice)
	if got := b.SessionForUser(`CORP\alice`); got != alice {
		t.Fatalf(`SessionForUser(CORP\alice) = %v, want alice's helper`, got)
	}
}
