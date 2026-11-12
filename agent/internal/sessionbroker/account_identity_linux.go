//go:build linux

package sessionbroker

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// getentPaths are the locations of glibc's getent, which answers through NSS
// (sssd, LDAP, winbind) where os/user without cgo reads only /etc/passwd.
var getentPaths = []string{"/usr/bin/getent", "/bin/getent"}

// systemAccountEntry looks up a passwd entry by login name or numeric UID and
// returns its name and UID.
func systemAccountEntry(key string) (name, uid string, err error) {
	if !validAccountName(key) {
		return "", "", errors.New("invalid account key")
	}
	getent := ""
	for _, p := range getentPaths {
		if fi, statErr := os.Stat(p); statErr == nil && fi.Mode().IsRegular() {
			getent = p
			break
		}
	}
	if getent == "" {
		return "", "", errors.New("getent not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), accountLookupTimeout)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, getent, "passwd", key).Output()
	if err != nil {
		return "", "", err
	}
	return parsePasswdEntry(string(out))
}

// parsePasswdEntry reads name and UID from the first line of passwd output.
func parsePasswdEntry(out string) (name, uid string, err error) {
	line, _, _ := strings.Cut(out, "\n")
	fields := strings.Split(strings.TrimSpace(line), ":")
	if len(fields) < 7 || fields[0] == "" || fields[2] == "" {
		return "", "", errors.New("malformed passwd entry")
	}
	return fields[0], fields[2], nil
}
