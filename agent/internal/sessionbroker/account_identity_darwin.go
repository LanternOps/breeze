//go:build darwin

package sessionbroker

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// idPath is the system id(1), which answers through Open Directory.
var idPath = "/usr/bin/id"

func runID(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), accountLookupTimeout)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, idPath, args...).Output()
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(out))
	if value == "" || strings.ContainsAny(value, "\n:") {
		return "", errors.New("unexpected id output")
	}
	return value, nil
}

// systemAccountEntry looks up an account by login name or numeric UID and
// returns its name and UID. id(1) takes a name before a number, so the
// answer is checked in both directions.
func systemAccountEntry(key string) (name, uid string, err error) {
	if !validAccountName(key) {
		return "", "", errors.New("invalid account key")
	}
	if _, numErr := strconv.ParseUint(key, 10, 32); numErr == nil {
		if name, err = runID("-nu", key); err != nil {
			return "", "", err
		}
		if uid, err = runID("-u", name); err != nil {
			return "", "", err
		}
		return name, uid, nil
	}
	if uid, err = runID("-u", key); err != nil {
		return "", "", err
	}
	if name, err = runID("-nu", uid); err != nil {
		return "", "", err
	}
	return name, uid, nil
}
