//go:build darwin

package heartbeat

import (
	"os/user"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// ensureDarwinHelperIPCGroupMembership puts every logged-in GUI user in the
// breeze group so their desktop helper can dial the 0660 root:breeze IPC socket.
//
// The socket half of #3133/#3134/#3137 (group-owning the socket) is useless on
// its own: an admin installs the agent, then a Standard user logs in, and that
// user is in no group the socket grants. The installers add users who are logged
// in at install time, which misses every later login — hence this runs from the
// daemon whenever it touches the helper LaunchAgents (login, session switch,
// self-update kickstart), so a user who logs in for the first time months after
// install still gets membership.
//
// Deliberately called BEFORE any launchctl kickstart/bootstrap: a helper process
// picks up its group list when it starts, so membership must exist first.
func ensureDarwinHelperIPCGroupMembership() {
	for _, uid := range findGUIUserUIDs() {
		if _, ok := guiUIDEligibleForIPCGroup(uid); !ok {
			continue
		}
		u, err := user.LookupId(uid)
		if err != nil {
			log.Warn("could not resolve GUI uid to a username for IPC group membership",
				"uid", uid, "group", sessionbroker.IPCGroupName, "error", err.Error())
			continue
		}
		added, err := sessionbroker.EnsureIPCGroupMember(u.Username)
		if err != nil {
			log.Warn("could not add console user to IPC group; that user's desktop helper will be denied the agent socket",
				"user", u.Username, "group", sessionbroker.IPCGroupName, "error", err.Error())
			continue
		}
		if added {
			log.Info("added console user to IPC group for desktop-helper socket access",
				"user", u.Username, "group", sessionbroker.IPCGroupName)
		}
	}
}
