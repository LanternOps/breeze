package sessionbroker

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// UserHelperBinaryName is the on-disk filename of the GUI-subsystem user-helper
// binary installed alongside the agent. Built from the same Go source as the
// agent with `-H windowsgui` so the Windows kernel does not allocate a console
// window when the scheduled task or SYSTEM-context spawn paths launch it in a
// user session. The constant is declared in this platform-independent file so
// resolveUserHelperPath is testable on every OS the agent builds on, even
// though only Windows actually uses the helper binary at runtime.
const UserHelperBinaryName = "breeze-user-helper.exe"

// resolveUserHelperPath picks the right binary path for a user-helper spawn,
// given the running agent's executable path. Pure function modulo the
// filesystem — extracted so it can be tested without depending on Windows
// build tags or os.Executable.
//
//   - sibling present → return sibling path
//   - sibling missing with fs.ErrNotExist → return agentExe with fallback provenance
//   - any other stat error → wrap and return
//
// The fallback exists because some failure modes (failed build, AV
// quarantine, partial MSI install) can leave the new scheduled task XML
// pointing at the helper while the helper binary is missing. Returning
// the agent path keeps run_as_user functionality alive at the cost of the
// visible console-window flash at user logon that this whole change set
// is meant to eliminate — so the fallback is a stop-gap, not a permanent
// shape. Once fleet telemetry confirms that the MSI install path reliably
// drops breeze-user-helper.exe alongside breeze-agent.exe on every
// supported install vector (msiexec /i, /fa repair, in-place upgrade via
// dev_update), the fs.ErrNotExist branch should be promoted to a hard
// error so the regression surfaces loudly instead of degrading silently.
// Without the fs.ErrNotExist branch any stat error would silently degrade.
// The owning spawner emits the warning once for fleet-side detection.
// ResolvedHelperExecutable records both the selected helper path and whether
// a missing Windows companion forced selection of the main agent binary.
type ResolvedHelperExecutable struct {
	Path               string
	MainBinaryFallback bool
}

func resolveUserHelperPath(agentExe string) (ResolvedHelperExecutable, error) {
	helper := filepath.Join(filepath.Dir(agentExe), UserHelperBinaryName)
	_, statErr := os.Stat(helper)
	if statErr == nil {
		return ResolvedHelperExecutable{Path: helper}, nil
	}
	if errors.Is(statErr, fs.ErrNotExist) {
		return ResolvedHelperExecutable{Path: agentExe, MainBinaryFallback: true}, nil
	}
	return ResolvedHelperExecutable{}, fmt.Errorf("stat %s: %w", helper, statErr)
}

// helperFallbackWarningOwner limits the missing-companion warning to the
// lifetime of its owning spawner. The lifecycle manager owns one spawner;
// legacy standalone calls each own one private spawner.
type helperFallbackWarningOwner struct {
	once sync.Once
}

func (o *helperFallbackWarningOwner) WarnIfFallback(resolved ResolvedHelperExecutable) {
	if o == nil || !resolved.MainBinaryFallback {
		return
	}
	o.once.Do(func() {
		log.Warn("breeze-user-helper.exe missing — falling back to agent binary; console window will flash at user logon until the install is repaired",
			"expectedPath", filepath.Join(filepath.Dir(resolved.Path), UserHelperBinaryName),
			"fallbackPath", resolved.Path,
		)
	})
}
