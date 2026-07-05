package patching

import (
	"errors"

	"github.com/breeze-rmm/agent/internal/config"
)

// NewEnsureDeps wires the real, host-touching EnsureDeps for EnsureWinget:
// Locate probes the WindowsApps folder for an existing winget.exe,
// AppxAvailable probes for the Add-AppxProvisionedPackage cmdlet, and
// Provision is a deliberate stub — Task 9b implements the real
// fetch/verify/provision flow against the Breeze API bootstrap endpoint.
// Until then, EnsureWinget treats a Provision error as "unavailable",
// which is the correct fallback: hosts with a pre-existing winget install
// keep working end to end, and hosts without one simply report unavailable
// instead of silently no-op'ing.
//
// cfg is accepted (rather than dropped) so the Task 9b Provision
// implementation can read the Breeze API base URL / auth without changing
// this function's signature or its call site in registerSystemWinget.
func NewEnsureDeps(cfg *config.Config) EnsureDeps {
	return EnsureDeps{
		Locate:        newWingetLocator().Locate,
		AppxAvailable: func() bool { return appxStackAvailable(DefaultRunner) },
		Provision: func() error {
			return errors.New("winget bootstrap provisioning not yet implemented")
		},
	}
}
