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
	out, dsclErr := runDscl(dsclGroupReadArgs(name))
	if dsclErr == nil {
		gid, parseErr := parseDsclPrimaryGroupID(out)
		if parseErr == nil {
			return gid, nil
		}
		dsclErr = parseErr
	}
	gid, stdlibErr := lookupGroupIDStdlib(name)
	if stdlibErr == nil {
		return gid, nil
	}
	return -1, fmt.Errorf("dscl: %v; os/user: %w", dsclErr, stdlibErr)
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
// shell script so the daemon, `breeze-agent service install`,
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
	if err := validIPCGroupMember(username); err != nil {
		return false, fmt.Errorf("ensure %q group member: %w", IPCGroupName, err)
	}
	if out, err := runDscl(dsclGroupMembershipReadArgs(IPCGroupName)); err == nil {
		if userInDsclGroupMembership(out, username) {
			return false, nil
		}
	}
	// A read failure is not fatal here: a group with no members at all makes
	// dscl exit non-zero for the missing GroupMembership key, which is the
	// normal state on a freshly created group. Fall through to the append and
	// let the verification read below be the authority.
	if _, err := runDscl(dsclGroupAppendMemberArgs(IPCGroupName, username)); err != nil {
		return false, err
	}
	out, err := runDscl(dsclGroupMembershipReadArgs(IPCGroupName))
	if err != nil {
		return false, fmt.Errorf("verify %q group membership for %q: %w", IPCGroupName, username, err)
	}
	if !userInDsclGroupMembership(out, username) {
		return false, fmt.Errorf("dscl reported success but %q is not in group %q", username, IPCGroupName)
	}
	return true, nil
}
