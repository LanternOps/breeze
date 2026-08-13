//go:build darwin

package sessionbroker

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// dsclTimeout bounds every dscl invocation. These run on the daemon startup
// path (setupSocket) and a wedged opendirectoryd is a real macOS failure mode,
// so a hung lookup must not hold the session broker — and therefore remote
// desktop, backup IPC and the watchdog link — hostage indefinitely.
const dsclTimeout = 10 * time.Second

func init() {
	ipcGroupIDLookup = lookupGroupIDDarwin
}

// lookupGroupIDDarwin resolves a group name via Directory Services first,
// falling back to os/user.
//
// dscl is the primary source because it is the store the installers write to.
// cgo-less os/user (how release darwin binaries are built) only parses
// /etc/group, which never contains the dscl-created `breeze` group, so relying
// on os/user first would fail on exactly the shipped configuration.
func lookupGroupIDDarwin(name string) (int, error) {
	return lookupGroupIDViaDscl(runDscl, name, lookupGroupIDStdlib)
}

// runDscl executes dscl with args and returns its combined output.
func runDscl(args []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dsclTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "dscl", args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("dscl %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// ensureIPCGroupScript creates the breeze group if absent, without assuming a
// fixed GID: it scans the local system GID range for a free slot. Kept as a
// shell script so the daemon, `nu-agent service install`,
// installer/macos/postinstall and scripts/install/install-darwin.sh all create
// the group identically.
const ensureIPCGroupScript = `
set -e
if dscl . -read /Groups/` + IPCGroupName + ` >/dev/null 2>&1; then
  dscl . -read /Groups/` + IPCGroupName + ` PrimaryGroupID >/dev/null
  exit 0
fi
gid=350
while [ "$gid" -le 499 ]; do
  if ! dscl . -list /Groups PrimaryGroupID 2>/dev/null | awk '{print $2}' | grep -qx "$gid"; then
    dscl . -create /Groups/` + IPCGroupName + `
    dscl . -create /Groups/` + IPCGroupName + ` PrimaryGroupID "$gid"
    exit 0
  fi
  gid=$((gid + 1))
done
echo "no free local system GID available for ` + IPCGroupName + ` group" >&2
exit 1
`

// EnsureIPCGroup creates the breeze group if it does not exist. Idempotent.
//
// This runs on every daemon start (from setupSocket) rather than at install
// time only. Hosts installed by an agent build that predates the group, or
// where an admin removed it, would otherwise never get a group for the socket
// to belong to and would stay broken forever.
func EnsureIPCGroup() error {
	ctx, cancel := context.WithTimeout(context.Background(), dsclTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/sh", "-c", ensureIPCGroupScript).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ensure %q group: %w: %s", IPCGroupName, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// EnsureIPCGroupMember adds username to the breeze group if absent, so that
// user's desktop helper can dial the 0660 root:breeze socket. Reports whether
// the membership was added (false when it already existed).
//
// The append is verified by re-reading the membership rather than trusting
// dscl's exit status, so a caller that sees a nil error knows the user really
// is a member.
func EnsureIPCGroupMember(username string) (bool, error) {
	outcome, err := ensureGroupMemberViaDscl(runDscl, IPCGroupName, username)
	if outcome.ReadErr != nil {
		// Logged rather than swallowed because this branch cannot tell the benign
		// "freshly created group has no GroupMembership key yet" case apart from a
		// real read failure (wedged opendirectoryd, a directory-bound node, a
		// permissions problem). In the benign case it fires at most once per host
		// — the append gives the group a member, so every later read succeeds — so
		// a line that keeps recurring is itself the signal something is wrong.
		log.Warn("could not read IPC group membership; assuming the group is empty and appending",
			"group", IPCGroupName, "user", username, "error", outcome.ReadErr.Error())
	}
	return outcome.Added, err
}
