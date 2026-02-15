//go:build darwin

package mgmtdetect

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

func collectIdentityStatus() IdentityStatus {
	id := IdentityStatus{Source: "darwin", JoinType: JoinTypeNone}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	adOutput, err := exec.CommandContext(ctx, "dsconfigad", "-show").CombinedOutput()
	if err != nil {
		if !errors.Is(err, exec.ErrNotFound) {
			log.Debug("dsconfigad command failed", "error", err)
		}
	} else {
		adText := string(adOutput)
		if strings.Contains(adText, "Active Directory Domain") {
			id.DomainJoined = true
			for _, line := range strings.Split(adText, "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "Active Directory Domain") {
					parts := strings.SplitN(line, "=", 2)
					if len(parts) == 2 {
						id.DomainName = strings.TrimSpace(parts[1])
					}
				}
			}
		}
	}

	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	profOutput, err := exec.CommandContext(ctx2, "profiles", "status", "-type", "enrollment").CombinedOutput()
	if err != nil {
		log.Debug("profiles status command failed", "error", err)
	} else {
		profText := strings.ToLower(string(profOutput))
		if strings.Contains(profText, "enrolled to an mdm server") || strings.Contains(profText, "mdm enrollment: yes") {
			id.MdmUrl = "enrolled"
		}
	}

	id.JoinType = deriveJoinType(id)
	return id
}
