package sessionbroker

import _ "embed"

// ensureIPCGroupLibFile is the shell library holding the one macOS rule for
// creating — or repairing (#7829) — the breeze group. It is also copied into
// the .pkg by installer/macos/build-pkg.sh and sourced by
// scripts/install/install-darwin.sh, so every install path and the daemon
// apply the same rule. Untagged so its behavioural tests run in the required
// Linux job.
const ensureIPCGroupLibFile = "ensure_ipc_group.sh"

//go:embed ensure_ipc_group.sh
var ensureIPCGroupLib string

// ensureIPCGroupScript is what EnsureIPCGroup runs under /bin/sh -c.
var ensureIPCGroupScript = "set -e\n" + ensureIPCGroupLib + "\nensure_breeze_group\n"
