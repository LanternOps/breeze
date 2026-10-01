package config

import "errors"

// ErrConfigDirUntrusted is returned when the agent's machine-wide config
// folder cannot be made trustworthy (it is a link the agent will not follow,
// or it could not be taken back), so the agent must not read it.
var ErrConfigDirUntrusted = errors.New("the agent config folder cannot be trusted")

// ReclaimConfigDir makes the machine-wide config folder one the agent can
// trust before it reads anything from it. Another account may have created
// that folder, or put files in it, before the agent was installed (for
// example an older Quick Support client run by a standard user). The agent
// re-secures its config folder if another account created it:
//
//   - A folder that is a link the agent will not follow is refused (Windows:
//     any reparse point; Unix: a symlink root does not own).
//   - Windows: if another account owns the folder, or anything directly in
//     it (or a link is in it), the folder is replaced, not repaired: a
//     process that opened it for writing while it was that account's keeps
//     that access after any owner or DACL change. A new folder is built with
//     the agent's descriptor, the config files the agent can trust are
//     carried over, and the old folder is renamed aside to
//     <folder>.untrusted-<time>. Otherwise the folder is re-hardened through
//     its handle and a config file with a loose DACL is re-secured in place.
//   - Unix (permissions apply immediately there): the folder is taken back
//     (root owner and group, no group/world write); in it, links another
//     account planted are removed and anything else that account owns is set
//     aside, unread, into quarantine/<time>/.
//   - agent.yaml and secrets.yaml (Unix: also helper_token.yaml) another
//     account owns are never adopted, at start or before enrolling: the
//     agent comes up unenrolled rather than run on contents (a server,
//     pinned keys, tool dirs) that account chose. The original is kept.
//
// Called by `breeze-agent enroll` (forEnroll, which only changes the log
// wording) and at agent start, before the instance guard and config.Load. A
// missing folder is not an error. On Unix only root can take a folder back,
// and a non-root run is not the installed agent, so it does nothing there.
func ReclaimConfigDir(forEnroll bool) error {
	if err := reclaimConfigDir(ConfigDir(), forEnroll); err != nil {
		return err
	}
	return reclaimSeparateDataDir()
}
