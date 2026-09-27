//go:build !windows

package config

import (
	"fmt"
	"os/user"
	"strconv"
)

// breezeGroupName is the dedicated OS group install.sh/postinstall create and
// add every console/GUI user to, so their desktop helper can dial the
// 0660 root:breeze IPC socket (internal/sessionbroker.IPCGroupName). Reused
// here for the same reason rather than inventing a second group: it already
// gets every local Helper user's membership managed by the installers.
//
// The lookup logic below is intentionally duplicated from
// internal/sessionbroker/ipc_group*.go rather than imported: importing that
// package would pull internal/pamactuator, internal/ipc and
// internal/backupipc into this package's dependency closure, which in turn
// widens the "Recovery media E2E (QEMU)" CI job's gate
// (.github/scripts/qemu-gate-paths.txt, built from cmd/breeze-backup and
// cmd/breeze-recovery-fakeserver's transitive imports) to code those binaries
// have nothing to do with. Config is imported everywhere; keeping its own
// dependency footprint minimal is worth ~20 duplicated lines.
const breezeGroupName = "breeze"

// breezeGroupIDLookupImpl resolves breezeGroupName to a numeric GID. A
// package-level var so breezegroup_darwin.go can install a dscl-aware
// override (see there for why) and so tests can inject a failure.
var breezeGroupIDLookupImpl = lookupBreezeGroupIDStdlib

// lookupBreezeGroupIDStdlib resolves a group name through os/user, which
// reads /etc/group correctly (no cgo needed) on Linux — where
// scripts/install/install-linux.sh creates the breeze group with groupadd —
// and is also darwin's fallback when dscl is unavailable.
func lookupBreezeGroupIDStdlib(name string) (int, error) {
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
