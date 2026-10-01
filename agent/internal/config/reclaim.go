package config

import "errors"

// ErrConfigDirUntrusted is returned when the agent's machine-wide config
// folder cannot be made trustworthy (it is a link, or its owner or a config
// file inside it could not be taken back), so the agent must not read it.
var ErrConfigDirUntrusted = errors.New("the agent config folder cannot be trusted")

// ReclaimConfigDir makes the machine-wide config folder one the agent can
// trust before it reads anything from it. Another account may have created
// that folder before the agent was installed (for example by running an older
// Quick Support client as a standard user), and the agent re-secures its
// data folder if another account created it:
//
//   - A folder that is a link to another location is refused.
//   - A folder another account owns is taken back: on Windows owner SYSTEM
//     (Administrators fallback) and the agent's PROTECTED DACL; on Unix owner
//     root with no group/world write.
//   - Every entry another account owns or can write is reset the same way,
//     recursively; links it planted are removed (the link, not its target).
//   - agent.yaml, secrets.yaml (and on Unix helper_token.yaml) that another
//     account owns or can write: with forEnroll they are removed, because
//     enrollment writes new ones and their contents (a server, pinned keys,
//     tool dirs) must not be carried into the new identity; otherwise they
//     are re-secured with a warning.
//
// Called by `breeze-agent enroll` (forEnroll) and at agent start, before
// config.Load. A missing folder is not an error. On Unix only root can take a
// folder back, and a non-root run is not the installed agent, so it is a
// no-op there.
func ReclaimConfigDir(forEnroll bool) error {
	if err := reclaimConfigDir(ConfigDir(), forEnroll); err != nil {
		return err
	}
	return reclaimSeparateDataDir()
}
