//go:build linux

package sessionbroker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
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
		return "", "", fmt.Errorf("%w: invalid account key", errAccountNotFound)
	}
	getent := ""
	for _, p := range getentPaths {
		if fi, statErr := os.Stat(p); statErr == nil && fi.Mode().IsRegular() {
			getent = p
			break
		}
	}
	if getent == "" {
		return "", "", fmt.Errorf("%w: getent not available", errAccountDirectoryUnavailable)
	}
	ctx, cancel := context.WithTimeout(context.Background(), accountLookupTimeout)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, getent, "passwd", key).Output()
	if err != nil {
		return "", "", classifyGetentError(ctx, err)
	}
	return parsePasswdEntry(string(out))
}

// classifyGetentError maps getent's exit status: 2 is "key not found"; 1
// (bad arguments or database) and a timeout mean the database did not
// answer.
func classifyGetentError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("%w: getent: %v", errAccountDirectoryUnavailable, err)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		switch exitErr.ExitCode() {
		case 2:
			return fmt.Errorf("%w: getent: %v", errAccountNotFound, err)
		case 1:
			return fmt.Errorf("%w: getent: %v", errAccountDirectoryUnavailable, err)
		}
	}
	return err
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
