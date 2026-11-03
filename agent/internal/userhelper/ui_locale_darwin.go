//go:build darwin

package userhelper

import (
	"context"
	"os/exec"
	"time"
)

// probeUILocaleOS reads the user's preferred languages. The user-helper runs
// as the signed-in user, so `-g` is that user's global domain.
func probeUILocaleOS() string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/defaults", "read", "-g", "AppleLanguages").Output()
	if err != nil {
		return ""
	}
	return parseAppleLanguages(string(out))
}
