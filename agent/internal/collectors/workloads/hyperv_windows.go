package workloads

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/hosttool"
	"golang.org/x/sys/windows"
)

// newHyperVDriver wires the Hyper-V driver to the host: the vmms service is
// queried with SERVICE_QUERY_STATUS only (it cannot start the service), and
// PowerShell is the host's own System32 copy by absolute path, never resolved
// through PATH.
func newHyperVDriver() Driver {
	return &hypervDriver{
		service:    func() serviceState { return queryServiceState("vmms") },
		version:    windowsBuild,
		powershell: hosttool.SystemTool(`WindowsPowerShell\v1.0\powershell.exe`),
		run:        runReadOnly,
		now:        time.Now,
	}
}

// windowsBuild is the host OS build ("10.0.20348"), which is also the Hyper-V
// build. RtlGetVersion is not subject to the manifest-based version lie.
func windowsBuild() string {
	v := windows.RtlGetVersion()
	if v == nil || v.MajorVersion == 0 {
		return ""
	}
	return fmt.Sprintf("%d.%d.%d", v.MajorVersion, v.MinorVersion, v.BuildNumber)
}
