//go:build darwin

package config

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// breezeGroupDsclTimeout bounds every dscl invocation so a wedged
// opendirectoryd can't hang a config save/load.
const breezeGroupDsclTimeout = 10 * time.Second

func init() {
	breezeGroupIDLookupImpl = lookupBreezeGroupIDDarwin
}

// lookupBreezeGroupIDDarwin resolves breezeGroupName via Directory Services
// first, falling back to os/user.
//
// dscl is tried first because it is the store the installers write to.
// Release darwin binaries build CGO_ENABLED=0 (scripts/build-edition.sh), and
// cgo-less os/user only parses /etc/group, which never contains a
// dscl-created group — so relying on os/user first would fail on exactly the
// shipped configuration. Mirrors
// internal/sessionbroker/ipc_group_darwin.go's lookupGroupIDDarwin.
func lookupBreezeGroupIDDarwin(name string) (int, error) {
	out, dsclErr := runBreezeGroupDscl([]string{".", "-read", "/Groups/" + name, "PrimaryGroupID"})
	if dsclErr == nil {
		if gid, parseErr := parseBreezeGroupDsclPrimaryGroupID(out); parseErr == nil {
			return gid, nil
		} else {
			dsclErr = parseErr
		}
	}
	gid, fallbackErr := lookupBreezeGroupIDStdlib(name)
	if fallbackErr == nil {
		return gid, nil
	}
	return -1, fmt.Errorf("dscl: %v; os/user: %w", dsclErr, fallbackErr)
}

func runBreezeGroupDscl(args []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), breezeGroupDsclTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "dscl", args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("dscl %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// parseBreezeGroupDsclPrimaryGroupID extracts the GID from `dscl . -read
// /Groups/<g> PrimaryGroupID` output, which looks like
// "PrimaryGroupID: 350". dscl also emits the folded form (key on its own
// line, value indented on the next) when the value is long, so both shapes
// are handled.
func parseBreezeGroupDsclPrimaryGroupID(out string) (int, error) {
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
