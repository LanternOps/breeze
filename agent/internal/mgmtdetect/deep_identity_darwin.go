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

	// Detect MDM enrollment using locale-invariant methods first, then fall
	// back to English text matching on older macOS versions.

	// Method 1: Check for MDM client preferences (locale-invariant).
	ctx2, cancel2 := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel2()
	mdmPref, err := exec.CommandContext(ctx2, "defaults", "read", "/Library/Preferences/com.apple.mdmclient").CombinedOutput()
	if err == nil && len(mdmPref) > 0 && !strings.Contains(string(mdmPref), "does not exist") {
		id.MdmUrl = "enrolled"
	}

	// Method 2: Check profiles list XML output for com.apple.mdm payload (locale-invariant).
	if id.MdmUrl == "" {
		ctx3, cancel3 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel3()
		profXml, err := exec.CommandContext(ctx3, "profiles", "list", "-output", "stdout-xml").CombinedOutput()
		if err == nil && strings.Contains(string(profXml), "com.apple.mdm") {
			id.MdmUrl = "enrolled"
		}
	}

	// Method 3: Fallback to profiles status text (English-only, for older macOS).
	if id.MdmUrl == "" {
		ctx4, cancel4 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel4()
		profOutput, err := exec.CommandContext(ctx4, "profiles", "status", "-type", "enrollment").CombinedOutput()
		if err == nil {
			profText := strings.ToLower(string(profOutput))
			if strings.Contains(profText, "enrolled to an mdm server") || strings.Contains(profText, "mdm enrollment: yes") {
				id.MdmUrl = "enrolled"
			}
		}
	}

	id.JoinType = deriveJoinType(id)
	return id
}
