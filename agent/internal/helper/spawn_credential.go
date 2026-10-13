//go:build !windows

package helper

import (
	"fmt"
	"os/user"
	"runtime"
	"strconv"
	"sync"
	"syscall"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// darwinMaxGroups is macOS NGROUPS_MAX. setgroups(2) rejects a longer list
// with EINVAL, which would fail cmd.Start and stop the helper launching at
// all. An ordinary admin account on macOS already sits at 16 groups.
const darwinMaxGroups = 16

// otherMaxGroups is Linux NGROUPS_MAX (65536 since 2.6.4).
const otherMaxGroups = 65536

func spawnMaxGroups() int {
	if runtime.GOOS == "darwin" {
		return darwinMaxGroups
	}
	return otherMaxGroups
}

// spawnWarned de-duplicates spawn-credential warnings so a helper that the
// watcher respawns repeatedly does not repeat the same line every time.
var spawnWarned sync.Map

// spawnCredential builds the credential the helper child runs under when the
// root agent spawns it for a console user.
//
// Groups must be populated. With Groups empty and NoSetGroups false, Go calls
// setgroups(0) in the child, which strips every supplementary group — including
// `breeze`, which owns both agent.sock (0660 root:breeze) and
// helper_token.yaml (0640 root:breeze). Assist then can never reach either
// token path (#8398). This mirrors initgroups(3): the user's own group list,
// nothing more.
func spawnCredential(u *user.User) (*syscall.Credential, error) {
	maxGroups := spawnMaxGroups()
	groupIDs, groupIDsErr := u.GroupIds()

	// The breeze gid only matters when we cannot use the full group list
	// as-is: on lookup failure, or when the list must be truncated and breeze
	// has to survive the cut. Skipping it otherwise avoids a dscl exec on
	// every spawn.
	breezeGID := -1
	if groupIDsErr != nil || len(groupIDs) > maxGroups {
		gid, err := sessionbroker.LookupIPCGroupID()
		if err != nil {
			warnSpawnCredentialOnce(u.Username, "could not resolve the breeze group while building the helper's groups; the helper may be unable to reach the agent socket",
				"error", err.Error())
		} else {
			breezeGID = gid
		}
	}

	cred, warning, err := spawnCredentialFromIDs(u.Uid, u.Gid, groupIDs, groupIDsErr, breezeGID, maxGroups)
	if err != nil {
		return nil, err
	}
	if warning != "" {
		warnSpawnCredentialOnce(u.Username, warning, "groups", fmt.Sprint(cred.Groups))
	}
	return cred, nil
}

// warnSpawnCredentialOnce logs msg at warn the first time it is seen for
// username in this process.
func warnSpawnCredentialOnce(username, msg string, args ...any) {
	if _, seen := spawnWarned.LoadOrStore(username+"\x00"+msg, struct{}{}); seen {
		return
	}
	log.Warn(msg, append([]any{"user", username}, args...)...)
}

// spawnCredentialFromIDs is the whole credential decision, split from the
// user-database lookups so every branch can be asserted without depending on
// the host's users and groups.
//
// Group order is primary gid, then breeze, then the rest, so truncation to
// maxGroups can never drop the group the helper needs to reach the agent.
// On the normal path breeze is carried only when the user is already a member
// (it is in groupIDs) — membership is the authorization signal, not the spawn
// path. The deliberate exception is a failed group lookup: membership cannot
// be checked, and dropping breeze would reintroduce #8398, so breezeGID (when
// resolvable) is added and a warning is returned. The agent socket's
// peer-credential and binary-path checks still gate admission.
//
// gid 0 is never carried as a supplementary group: this child draws a GUI and
// talks to the agent, and root-group access is not part of that.
//
// The returned warning is non-empty when the result is degraded (lookup
// failure or truncation); the caller logs it.
func spawnCredentialFromIDs(uid, gid string, groupIDs []string, groupIDsErr error, breezeGID int, maxGroups int) (*syscall.Credential, string, error) {
	uidN, err := strconv.ParseUint(uid, 10, 32)
	if err != nil {
		return nil, "", fmt.Errorf("parse uid %q: %w", uid, err)
	}
	gidN, err := strconv.ParseUint(gid, 10, 32)
	if err != nil {
		return nil, "", fmt.Errorf("parse gid %q: %w", gid, err)
	}

	cred := &syscall.Credential{Uid: uint32(uidN), Gid: uint32(gidN)}
	seen := make(map[uint32]bool)
	add := func(g uint32) {
		if seen[g] {
			return
		}
		seen[g] = true
		cred.Groups = append(cred.Groups, g)
	}

	// Primary gid first: initgroups(3) includes it, and it guarantees Groups
	// is never empty.
	add(uint32(gidN))

	var warning string
	if groupIDsErr != nil {
		if breezeGID > 0 {
			add(uint32(breezeGID))
		}
		return cred, fmt.Sprintf("could not list the user's groups for the helper spawn; using primary group plus breeze only: %v", groupIDsErr), nil
	}

	var rest []uint32
	memberOfBreeze := false
	for _, s := range groupIDs {
		n, err := strconv.ParseUint(s, 10, 32)
		if err != nil || n == 0 {
			continue
		}
		if breezeGID > 0 && n == uint64(breezeGID) {
			memberOfBreeze = true
			continue
		}
		rest = append(rest, uint32(n))
	}
	if memberOfBreeze {
		add(uint32(breezeGID))
	}
	for _, g := range rest {
		add(g)
	}

	if maxGroups > 0 && len(cred.Groups) > maxGroups {
		kept := "the helper keeps its primary and breeze groups and drops the rest past the limit"
		if !memberOfBreeze {
			// Either the user is not a member, or breeze could not be resolved
			// and so could not be moved ahead of the cut.
			kept = "the breeze group was not prioritised (unresolved or not a member) and may have been dropped; the helper may be unable to reach the agent socket"
		}
		warning = fmt.Sprintf("user is in %d groups, more than the %d this OS allows a process; %s",
			len(cred.Groups), maxGroups, kept)
		cred.Groups = cred.Groups[:maxGroups]
	}
	return cred, warning, nil
}
