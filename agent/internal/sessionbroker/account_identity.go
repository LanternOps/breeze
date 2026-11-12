package sessionbroker

import (
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// Helper session accounts.
//
// A helper session belongs to the account its kernel-verified peer identity
// names: the token SID on Windows, the socket peer UID elsewhere. The broker
// resolves that account's name itself when the helper connects, and name-based
// session selection (SessionForUser) resolves the requested name to an
// identity and matches it against each session's verified identity. The
// Username field of the helper's auth request is not used for either.
//
// Name resolution goes through the OS account database, so domain accounts on
// Windows (DOMAIN\user, user@domain, or a bare name) and directory accounts
// on Linux (LDAP, AD, SSSD via NSS, also from builds without cgo) and macOS
// (Open Directory) resolve the same way local accounts do. A lookup that
// fails or does not answer in time never refuses the helper: the session is
// admitted with no account name and stays reachable through its identity.

// maxAccountNameLen bounds a requested account name (a Windows
// DOMAIN\user or user@domain name, a Unix login name).
const maxAccountNameLen = 512

// accountLookupTimeout bounds one account lookup. Directory lookups can
// block for a long time when a domain controller or LDAP server is
// unreachable; an abandoned lookup finishes in the background.
var accountLookupTimeout = 3 * time.Second

var errAccountLookupTimeout = errors.New("account lookup timed out")

// accountDirectory translates between account names and the identity keys
// the kernel reports for IPC peers.
type accountDirectory struct {
	nameForIdentity func(identity string) (string, error)
	identityForName func(name string) (string, error)
}

var platformAccounts = accountDirectory{
	nameForIdentity: platformAccountNameForIdentity,
	identityForName: platformAccountIdentityForName,
}

func (b *Broker) accountLookups() accountDirectory {
	if b.accounts != nil {
		return *b.accounts
	}
	return platformAccounts
}

func lookupWithTimeout(lookup func(string) (string, error), key string) (string, error) {
	type answer struct {
		value string
		err   error
	}
	done := make(chan answer, 1)
	go func() {
		value, err := lookup(key)
		done <- answer{value, err}
	}()
	timer := time.NewTimer(accountLookupTimeout)
	defer timer.Stop()
	select {
	case a := <-done:
		return a.value, a.err
	case <-timer.C:
		return "", errAccountLookupTimeout
	}
}

// peerAccountName returns the name of the account a verified identity key
// belongs to, or "" when it cannot be resolved.
func (b *Broker) peerAccountName(identity string) string {
	if identity == "" {
		return ""
	}
	name, err := lookupWithTimeout(b.accountLookups().nameForIdentity, identity)
	if err != nil || strings.TrimSpace(name) == "" {
		reason := "empty account name"
		if err != nil {
			reason = err.Error()
		}
		log.Warn("helper account name could not be resolved from its verified identity; the session is reachable by identity only",
			"identity", identity, "error", reason)
		return ""
	}
	return name
}

// validAccountName reports whether name may be passed to an account lookup.
func validAccountName(name string) bool {
	if name == "" || len(name) > maxAccountNameLen || strings.HasPrefix(name, "-") {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// accountIdentityForName resolves a requested account name to the identity
// key of the account. When the account database cannot answer, the name is
// matched against the account names resolved from connected sessions'
// verified identities; a name that matches more than one account resolves
// to nothing.
func (b *Broker) accountIdentityForName(username string) string {
	name := strings.TrimSpace(username)
	if !validAccountName(name) {
		return ""
	}
	if identity, err := lookupWithTimeout(b.accountLookups().identityForName, name); err == nil && identity != "" {
		return identity
	}

	b.mu.RLock()
	defer b.mu.RUnlock()
	goos := b.effectiveGOOS()
	match := ""
	for _, s := range b.sessions {
		if s.accountIdentity == "" || s.Username == "" || !accountNameMatches(goos, name, s.Username) {
			continue
		}
		if match != "" && match != s.accountIdentity {
			return ""
		}
		match = s.accountIdentity
	}
	return match
}

// accountNameMatches compares a requested name with a resolved account name.
// Windows names are case-insensitive, and a bare name matches the account
// part of DOMAIN\account.
func accountNameMatches(goos, requested, resolved string) bool {
	if goos != "windows" {
		return requested == resolved
	}
	if strings.EqualFold(requested, resolved) {
		return true
	}
	if strings.ContainsAny(requested, `\@`) {
		return false
	}
	if i := strings.LastIndex(resolved, `\`); i >= 0 {
		return strings.EqualFold(requested, resolved[i+1:])
	}
	return false
}

// takesPerUserWork reports whether a session of this role can be selected
// by account name. The watchdog and backup helpers are agent-internal and
// never serve per-user requests.
func takesPerUserWork(role ipc.HelperRole) bool {
	return role != ipc.HelperRoleWatchdog && role != backupipc.HelperRoleBackup
}
