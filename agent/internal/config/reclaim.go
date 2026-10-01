package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ErrConfigDirUntrusted is returned when the agent's machine-wide config
// folder cannot be made trustworthy (it is a link the agent will not follow,
// or it could not be taken back), so the agent must not read it.
var ErrConfigDirUntrusted = errors.New("the agent config folder cannot be trusted")

// ReclaimConfigDir makes the machine-wide config folder one the agent can
// trust before it reads anything from it. Another account may have created
// that folder before the agent was installed (for example an older Quick
// Support client run by a standard user); the agent re-secures its config
// folder if another account created it:
//
//   - The folder itself is taken back (Windows: by handle, refusing a link,
//     SYSTEM owner and the agent's PROTECTED DACL; Unix: root owner, no world
//     write; a symlink is followed only when root owns it). After that no
//     other account can add, rename or replace entries in it.
//   - Only the folder's own entries are examined; nothing another account
//     controls is walked into, so no check or change can be redirected.
//     Links are removed (never followed). Other entries another account owns
//     or can write are set aside, unread, into quarantine/<time>/.
//   - agent.yaml and secrets.yaml (Unix: also helper_token.yaml) another
//     account could write: before enrolling, set aside when another account
//     owns them (enrollment writes new ones, and their contents must not
//     carry into the new identity); otherwise replaced by a fresh copy the
//     agent writes itself, so a handle that account holds no longer reaches
//     the file, with a warning to check the contents.
//
// Called by `breeze-agent enroll` (forEnroll) and at agent start, before
// config.Load. A missing folder is not an error. On Unix only root can take a
// folder back, and a non-root run is not the installed agent, so it does
// nothing there.
func ReclaimConfigDir(forEnroll bool) error {
	if err := reclaimConfigDir(ConfigDir(), forEnroll); err != nil {
		return err
	}
	return reclaimSeparateDataDir()
}

// reclaimQuarantineDir is the folder entries are set aside in, inside the
// config folder (so it is as private as the folder).
const reclaimQuarantineDir = "quarantine"

type quarantine struct{ root, dir string }

// move renames path (an entry of q.root, which the caller has already taken
// back) into this run's quarantine folder. A rename moves the entry itself:
// a link is moved, not followed.
func (q *quarantine) move(path, name string) error {
	if q.dir == "" {
		q.dir = filepath.Join(q.root, reclaimQuarantineDir, time.Now().UTC().Format("20060102T150405.000000000Z"))
		if err := os.MkdirAll(q.dir, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", q.dir, err)
		}
	}
	if err := os.Rename(path, filepath.Join(q.dir, name)); err != nil {
		return fmt.Errorf("set aside %s: %w", path, err)
	}
	return nil
}
