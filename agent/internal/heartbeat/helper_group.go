package heartbeat

import "strconv"

// minGUIUIDForIPCGroup is the first UID macOS assigns to a human account.
// Everything below 500 is a system/service account (`_windowserver`, `_spotlight`,
// …) which never runs a Breeze desktop helper, so those must not be appended to
// the breeze group — widening a privileged group to service accounts for no
// benefit.
const minGUIUIDForIPCGroup = 500

// guiUIDEligibleForIPCGroup reports whether a UID string from findGUIUserUIDs
// belongs to a human console account that should be a member of the breeze
// group. Root (0) is excluded because the login-window helper already runs as
// root and needs no group membership.
func guiUIDEligibleForIPCGroup(uid string) (int, bool) {
	n, err := strconv.Atoi(uid)
	if err != nil || n < minGUIUIDForIPCGroup {
		return 0, false
	}
	return n, true
}
