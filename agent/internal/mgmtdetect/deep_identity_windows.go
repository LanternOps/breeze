//go:build windows

package mgmtdetect

import (
	"context"
	"os/exec"
	"time"
)

func collectIdentityStatus() IdentityStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "dsregcmd", "/status")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return IdentityStatus{JoinType: "none", Source: "dsregcmd_error"}
	}
	return parseDsregcmdOutput(string(output))
}
