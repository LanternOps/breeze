//go:build darwin && !cgo

package sessionbroker

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type darwinDetectorNoCgo struct{}

// NewSessionDetector creates a macOS session detector that uses command-line
// tools instead of CGO. This is the fallback for CGO_ENABLED=0 builds.
func NewSessionDetector() SessionDetector {
	return &darwinDetectorNoCgo{}
}

func (d *darwinDetectorNoCgo) ListSessions() ([]DetectedSession, error) {
	// Use "stat -f %Su /dev/console" to get the console user without CGO
	ctx, cancel := context.WithTimeout(context.Background(), detectorCommandTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "stat", "-f", "%Su", "/dev/console").Output()
	if err != nil {
		return nil, fmt.Errorf("failed to detect console user via stat: %w", err)
	}
	username, err := sanitizeDetectedField(strings.TrimSpace(string(out)), true)
	if err != nil {
		return nil, fmt.Errorf("invalid console user: %w", err)
	}
	if username == "" || username == "root" || username == "loginwindow" {
		return nil, nil
	}

	// Resolve UID for the console user (needed for launchctl domain targeting)
	uidCtx, uidCancel := context.WithTimeout(context.Background(), detectorCommandTimeout)
	defer uidCancel()
	uidOut, err := exec.CommandContext(uidCtx, "id", "-u", username).Output()
	if err != nil {
		return nil, fmt.Errorf("failed to resolve UID for user %q: %w", username, err)
	}
	uid64, err := strconv.ParseUint(strings.TrimSpace(string(uidOut)), 10, 32)
	if err != nil {
		return nil, fmt.Errorf("failed to parse UID for user %q: %w", username, err)
	}

	session, err := sanitizeDetectedSession(DetectedSession{
		UID:      uint32(uid64),
		Username: username,
		Session:  "console",
		Display:  "quartz",
		State:    "active",
		Type:     "console",
	})
	if err != nil {
		return nil, err
	}

	return []DetectedSession{session}, nil
}

func (d *darwinDetectorNoCgo) WatchSessions(ctx context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent, 8)

	go func() {
		defer close(ch)

		var lastUser string
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		// Get initial state
		if sessions, err := d.ListSessions(); err == nil && len(sessions) > 0 {
			lastUser = sessions[0].Username
		}

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				var currentUser string
				if sessions, err := d.ListSessions(); err == nil && len(sessions) > 0 {
					currentUser = sessions[0].Username
				}

				if currentUser != lastUser {
					if lastUser != "" {
						ch <- SessionEvent{
							Type:     SessionLogout,
							Username: lastUser,
							Session:  "console",
						}
					}
					if currentUser != "" {
						ch <- SessionEvent{
							Type:     SessionLogin,
							Username: currentUser,
							Session:  "console",
							Display:  "quartz",
						}
					}
					lastUser = currentUser
				}
			}
		}
	}()

	return ch
}
