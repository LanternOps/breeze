//go:build windows

package mgmtdetect

import (
	"context"
	"os/exec"
	"time"

	"golang.org/x/sys/windows/registry"
)

func collectIdentityStatus() IdentityStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "dsregcmd", "/status")
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Warn("dsregcmd failed, falling back to registry", "error", err.Error())
		fb := collectIdentityStatusFromRegistry()
		// Tag the source so the UI shows the real reason, not just "dsregcmd_error"
		if fb.JoinType == JoinTypeNone {
			fb.Source = "dsregcmd_error_no_fallback"
		}
		return fb
	}

	id := parseDsregcmdOutput(string(output))
	// dsregcmd is the source of truth when it runs. But it has been observed
	// to mis-report on some Server 2016 DCs (return success with no JoinInfo).
	// As a sanity check, if it reports no join at all, try the registry; if
	// the registry knows about classic AD membership, trust that.
	if id.JoinType == JoinTypeNone {
		fb := collectIdentityStatusFromRegistry()
		if fb.JoinType != JoinTypeNone {
			fb.Source = "registry_fallback_after_dsregcmd_none"
			return fb
		}
	}
	return id
}

// collectIdentityStatusFromRegistry reads canonical Win32 registry locations
// for classic AD domain membership. Used when dsregcmd is unavailable, errors,
// or returns no join info.
//
// Detects classic on-prem AD via HKLM\SYSTEM\...\Tcpip\Parameters\Domain.
// (Azure AD via HKLM\...\CloudDomainJoin\JoinInfo could be added later if
// needed; the dsregcmd path remains primary for Azure AD detection.)
func collectIdentityStatusFromRegistry() IdentityStatus {
	id := IdentityStatus{Source: "registry"}

	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Services\Tcpip\Parameters`,
		registry.READ)
	if err != nil {
		log.Warn("registry identity fallback: failed to open Tcpip\\Parameters", "error", err.Error())
		id.JoinType = JoinTypeNone
		return id
	}
	defer k.Close()

	if domain, _, derr := k.GetStringValue("Domain"); derr == nil && domain != "" {
		id.DomainJoined = true
		id.DomainName = domain
	}

	id.JoinType = deriveJoinType(id)
	return id
}
