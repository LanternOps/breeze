//go:build !windows

package sessionbroker

import (
	"fmt"
	"os/user"
	"strconv"
)

// platformAccountNameForIdentity returns the login name of a UID. os/user is
// tried first; agents built without cgo read only /etc/passwd there, so a
// miss falls through to the system account database (NSS on Linux, Open
// Directory on macOS), where directory accounts live.
func platformAccountNameForIdentity(identity string) (string, error) {
	if _, err := strconv.ParseUint(identity, 10, 32); err != nil {
		return "", fmt.Errorf("%w: invalid uid %q", errAccountNotFound, identity)
	}
	if u, err := user.LookupId(identity); err == nil && u.Username != "" {
		return u.Username, nil
	}
	name, uid, err := systemAccountEntry(identity)
	if err != nil {
		return "", err
	}
	if uid != identity || name == "" {
		return "", fmt.Errorf("%w: account database returned uid %q for uid %q", errAccountNotFound, uid, identity)
	}
	return name, nil
}

// platformAccountIdentityForName returns the UID of a login name, with the
// same fallback as platformAccountNameForIdentity.
func platformAccountIdentityForName(name string) (string, error) {
	if !validAccountName(name) {
		return "", fmt.Errorf("%w: invalid account name", errAccountNotFound)
	}
	if u, err := user.Lookup(name); err == nil && u.Uid != "" {
		return u.Uid, nil
	}
	entryName, uid, err := systemAccountEntry(name)
	if err != nil {
		return "", err
	}
	if entryName != name {
		return "", fmt.Errorf("%w: account database returned %q for %q", errAccountNotFound, entryName, name)
	}
	if _, err := strconv.ParseUint(uid, 10, 32); err != nil {
		return "", fmt.Errorf("account database returned invalid uid %q", uid)
	}
	return uid, nil
}
