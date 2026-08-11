package sessionbroker

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"strconv"
	"strings"
)

// IPCGroupName is the dedicated OS group that owns the agent's IPC socket.
//
// The daemon runs as root, so without an explicit group the socket lands on
// whatever group the daemon's process inherits. On macOS that is worse than a
// coin flip: BSD semantics give a newly created file the *parent directory's*
// group, and the socket's parent is /Library/Application Support/Breeze, which
// is group `admin`. Mode 0660 + group `admin` means a Standard (non-admin)
// console user's desktop helper can never dial the socket, which is exactly
// what #3133/#3134/#3137 reported: `srw-rw---- root:admin` and
// `dial unix .../agent.sock: permission denied`.
//
// The three install paths (installer/macos/postinstall,
// scripts/install/install-darwin.sh, and `breeze-agent service install`) all
// create this group already; the missing half was ever applying it to the
// socket and putting the console user in it.
const IPCGroupName = "breeze"

// ipcSocketMode is the mode applied to the IPC socket on every daemon start.
//
// Deliberately NOT 0666. Peer-credential + binary-path verification
// (internal/ipc) is the real admission gate, but the filesystem mode is
// defence in depth: a world-writable socket lets any local process connect and
// spend the broker's admission budget, and it is a footgun if the peer checks
// are ever loosened. 0660 with a real group that the console user belongs to
// gives the same reachability without opening the socket to every UID on the
// box. TestIPCSocketModeIsNotWorldAccessible pins this.
const ipcSocketMode os.FileMode = 0o660

// ipcGroupIDLookup resolves a group name to its GID. It is a variable so
// ipc_group_darwin.go can install a Directory Services aware implementation and
// so tests can inject failures.
//
// The darwin override is load-bearing, not a nicety: release darwin binaries
// are cross-compiled with CGO_ENABLED=0 (scripts/build-edition.sh defaults it to
// 0), and cgo-less os/user parses /etc/group, which never contains a
// dscl-created group like `breeze`. Without the dscl-backed override the lookup
// would fail on every shipped macOS build — the precise platform this fixes.
var ipcGroupIDLookup = lookupGroupIDStdlib

// lookupGroupIDStdlib resolves a group name through os/user.
func lookupGroupIDStdlib(name string) (int, error) {
	g, err := user.LookupGroup(name)
	if err != nil {
		return -1, err
	}
	gid, err := strconv.Atoi(g.Gid)
	if err != nil {
		return -1, fmt.Errorf("group %q has non-numeric gid %q: %w", name, g.Gid, err)
	}
	return gid, nil
}

// LookupIPCGroupID resolves IPCGroupName to a numeric GID.
func LookupIPCGroupID() (int, error) {
	return ipcGroupIDLookup(IPCGroupName)
}

// socketOwner is the ownership + mode the IPC socket must end up with.
// A GID of -1 means "leave the group alone" (os.Chown's no-change sentinel),
// used when the breeze group cannot be resolved.
type socketOwner struct {
	GID  int
	Mode os.FileMode
}

// resolveSocketOwner determines the ownership to apply to the IPC socket.
//
// On lookup failure it returns a usable owner (GID -1, mode 0660) *alongside*
// the error so the caller can still tighten the mode and log the reason. It
// never returns a widened mode: a missing group must not translate into a more
// permissive socket.
func resolveSocketOwner(lookupGID func(string) (int, error)) (socketOwner, error) {
	owner := socketOwner{GID: -1, Mode: ipcSocketMode}
	gid, err := lookupGID(IPCGroupName)
	if err != nil {
		return owner, fmt.Errorf("lookup group %q: %w", IPCGroupName, err)
	}
	if gid < 0 {
		return owner, fmt.Errorf("lookup group %q: got negative gid %d", IPCGroupName, gid)
	}
	owner.GID = gid
	return owner, nil
}

// socketOwnerResult reports the outcome of applying ownership to the socket.
// The two errors are deliberately separate because they have different
// severities — see applySocketOwner.
type socketOwnerResult struct {
	// ChownErr is non-fatal. Losing the group means user-session helpers stay
	// denied (the pre-fix status quo), but the socket still works for root
	// clients, so the broker must keep running: aborting would also take down
	// remote desktop, backup IPC and the watchdog link.
	ChownErr error
	// ChmodErr is fatal. net.Listen creates the socket at 0777&^umask, so a
	// socket whose chmod failed keeps whatever the listener's umask produced.
	// Under an unusual umask that could be world-writable, so this path fails
	// closed rather than serving a socket with an unverified mode.
	ChmodErr error
}

// applySocketOwner applies owner to path.
//
// chown runs before chmod so the mode is the last word (some platforms clear
// mode bits on ownership change), and the chmod is attempted even when the chown
// failed — skipping it would leave the socket at the listener's default mode,
// which is the one outcome that could be more permissive than intended.
func applySocketOwner(
	path string,
	owner socketOwner,
	chown func(name string, uid, gid int) error,
	chmod func(name string, mode os.FileMode) error,
) socketOwnerResult {
	var res socketOwnerResult
	if owner.GID >= 0 {
		// uid -1 keeps the existing owner (root).
		if err := chown(path, -1, owner.GID); err != nil {
			res.ChownErr = fmt.Errorf("chown %s to group %d: %w", path, owner.GID, err)
		}
	}
	if err := chmod(path, owner.Mode); err != nil {
		res.ChmodErr = fmt.Errorf("chmod %s to %#o: %w", path, owner.Mode, err)
	}
	return res
}

// dsclRunner runs dscl with args and returns its combined output. It exists so
// the orchestration below (lookup composition, membership ensure) can live in
// this untagged file and be table-tested on every CI runner, leaving only the
// exec.Command call behind the darwin build tag.
type dsclRunner func(args []string) (string, error)

// lookupGroupIDViaDscl resolves a group name through dscl, falling back to
// fallback (os/user) when dscl either fails or returns output it cannot parse.
//
// dscl is tried first because it is the store the installers write to, and
// because cgo-less os/user only parses /etc/group, which never contains a
// dscl-created group. When both fail the returned error names both causes —
// diagnosing this without knowing which layer said what is guesswork.
func lookupGroupIDViaDscl(run dsclRunner, name string, fallback func(string) (int, error)) (int, error) {
	out, dsclErr := run(dsclGroupReadArgs(name))
	if dsclErr == nil {
		gid, parseErr := parseDsclPrimaryGroupID(out)
		if parseErr == nil {
			return gid, nil
		}
		dsclErr = parseErr
	}
	gid, fallbackErr := fallback(name)
	if fallbackErr == nil {
		return gid, nil
	}
	return -1, fmt.Errorf("dscl: %v; os/user: %w", dsclErr, fallbackErr)
}

// groupMemberOutcome is the result of ensureGroupMemberViaDscl.
type groupMemberOutcome struct {
	// Added is true when this call appended the membership, false when the user
	// was already a member.
	Added bool
	// ReadErr is the non-fatal error from the membership read that precedes the
	// append, if any. A freshly created group with no members makes dscl exit
	// non-zero for the missing GroupMembership key, which is benign — but this
	// layer cannot tell that apart from a real read failure, so it hands the
	// error up to be logged rather than discarding it.
	ReadErr error
}

// ensureGroupMemberViaDscl adds username to group if it is not already a member.
//
// The append is verified by re-reading the membership rather than trusting
// dscl's exit status, so a nil error genuinely means the user is a member.
func ensureGroupMemberViaDscl(run dsclRunner, group, username string) (groupMemberOutcome, error) {
	if err := validIPCGroupMember(username); err != nil {
		return groupMemberOutcome{}, fmt.Errorf("ensure %q group member: %w", group, err)
	}

	out, readErr := run(dsclGroupMembershipReadArgs(group))
	if readErr == nil && userInDsclGroupMembership(out, username) {
		return groupMemberOutcome{Added: false}, nil
	}
	outcome := groupMemberOutcome{ReadErr: readErr}

	if _, err := run(dsclGroupAppendMemberArgs(group, username)); err != nil {
		return outcome, err
	}
	out, err := run(dsclGroupMembershipReadArgs(group))
	if err != nil {
		return outcome, fmt.Errorf("verify %q group membership for %q: %w", group, username, err)
	}
	if !userInDsclGroupMembership(out, username) {
		return outcome, fmt.Errorf("dscl reported success but %q is not in group %q", username, group)
	}
	outcome.Added = true
	return outcome, nil
}

// validIPCGroupMember rejects usernames that must never reach a privileged
// dscl argv. In practice the name comes from user.LookupId on a live console
// UID and is always well-formed, but a name carrying whitespace — or one that
// dscl would parse as a flag because it starts with '-' — would turn a
// membership append into a different command, so it is rejected here rather
// than trusted.
func validIPCGroupMember(username string) error {
	switch {
	case username == "":
		return errors.New("empty username")
	case strings.HasPrefix(username, "-"):
		return fmt.Errorf("username %q starts with '-'", username)
	case strings.ContainsAny(username, " \t\r\n"):
		return fmt.Errorf("username %q contains whitespace", username)
	}
	return nil
}

// dsclGroupReadArgs builds the argv that reads a group's PrimaryGroupID from
// the local Directory Services node.
func dsclGroupReadArgs(group string) []string {
	return []string{".", "-read", "/Groups/" + group, "PrimaryGroupID"}
}

// dsclGroupMembershipReadArgs builds the argv that reads a group's membership.
func dsclGroupMembershipReadArgs(group string) []string {
	return []string{".", "-read", "/Groups/" + group, "GroupMembership"}
}

// dsclGroupAppendMemberArgs builds the argv that adds user to group.
func dsclGroupAppendMemberArgs(group, username string) []string {
	return []string{".", "-append", "/Groups/" + group, "GroupMembership", username}
}

// parseDsclPrimaryGroupID extracts the GID from `dscl . -read /Groups/<g>
// PrimaryGroupID` output, which looks like "PrimaryGroupID: 350". dscl also
// emits the folded form (key on its own line, value indented on the next) when
// the value is long, so both shapes are handled.
func parseDsclPrimaryGroupID(out string) (int, error) {
	fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(out), "PrimaryGroupID:"))
	if len(fields) == 0 {
		return -1, fmt.Errorf("dscl: no PrimaryGroupID in output %q", strings.TrimSpace(out))
	}
	gid, err := strconv.Atoi(fields[0])
	if err != nil {
		return -1, fmt.Errorf("dscl: non-numeric PrimaryGroupID %q", fields[0])
	}
	if gid < 0 {
		return -1, fmt.Errorf("dscl: negative PrimaryGroupID %d", gid)
	}
	return gid, nil
}

// userInDsclGroupMembership reports whether username appears in `dscl . -read
// /Groups/<g> GroupMembership` output. Matching is on whole space-separated
// tokens so "jing" does not match a membership list containing "jingxie".
// An empty username never matches.
func userInDsclGroupMembership(out, username string) bool {
	if username == "" {
		return false
	}
	for _, field := range strings.Fields(strings.TrimPrefix(strings.TrimSpace(out), "GroupMembership:")) {
		if field == username {
			return true
		}
	}
	return false
}
