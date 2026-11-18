//go:build linux

package sessionbroker

import (
	"context"
	"fmt"
	"strconv"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
	"github.com/breeze-rmm/agent/internal/procspawn"
)

// maxLoginctlOutput bounds what one loginctl call may return; the
// properties asked for are a few dozen bytes.
const maxLoginctlOutput = 64 << 10

func defaultLinuxLogindLookup() logindLookupFunc { return lookupLinuxLogindSession }

// recordRunningBuildHash hashes the executable this process is running. It
// reads /proc/self/exe, which opens the inode the kernel mapped at exec, so a
// self-update that has already replaced the file on disk does not change
// the answer. "" (logged) when it cannot be read; Linux desktop helper
// admission then refuses every helper.
func recordRunningBuildHash() string {
	sum, err := hashFileSHA256("/proc/self/exe")
	if err != nil {
		log.Warn("could not hash the running agent executable; Linux desktop helpers will be refused", "error", err.Error())
		return ""
	}
	return sum
}

// lookupLinuxLogindSession reads one logind session for desktop helper
// admission (#12117), with explicit `loginctl show-session` queries rather
// than the list-row defaults the session detector starts from. Any failure to
// read another session of the same uid marks the result PropertiesUnknown,
// which admission refuses.
func lookupLinuxLogindSession(ctx context.Context, id string) (LogindSessionState, error) {
	if !validLogindSessionID(id) {
		return LogindSessionState{}, fmt.Errorf("invalid logind session id %q", id)
	}
	loginctl, err := linuxsession.ResolveSystemBinary("loginctl")
	if err != nil {
		return LogindSessionState{}, fmt.Errorf("resolve loginctl: %w", err)
	}
	out, err := runLoginctl(ctx, loginctl, "show-session", id, "--property=Id,User,Type,State,Class,Remote")
	if err != nil {
		return LogindSessionState{}, fmt.Errorf("loginctl show-session %s: %w", id, err)
	}
	st := parseLogindShowSession(id, out)
	if st.PropertiesUnknown || !st.Exists {
		return st, nil
	}

	userOut, err := runLoginctl(ctx, loginctl, "show-user", strconv.FormatUint(uint64(st.UID), 10), "--property=Sessions")
	if err != nil {
		st.PropertiesUnknown = true
		return st, nil
	}
	others, ok := parseLogindUserSessions(userOut)
	if !ok {
		st.PropertiesUnknown = true
		return st, nil
	}
	for _, other := range others {
		if other == id {
			continue
		}
		otherOut, err := runLoginctl(ctx, loginctl, "show-session", other, "--property=Type,Remote")
		if err != nil {
			st.PropertiesUnknown = true
			return st, nil
		}
		graphical, ok := isLocalGraphicalLogindSession(otherOut)
		if !ok {
			st.PropertiesUnknown = true
			return st, nil
		}
		if graphical {
			st.OtherGraphicalSessions++
		}
	}
	return st, nil
}

func runLoginctl(ctx context.Context, loginctl string, args ...string) (string, error) {
	args = append(args, "--no-pager")
	out, err := procspawn.CommandContext(ctx, loginctl, args...).Output()
	if err != nil {
		return "", err
	}
	if len(out) > maxLoginctlOutput {
		return "", fmt.Errorf("loginctl output too large (%d bytes)", len(out))
	}
	return string(out), nil
}
