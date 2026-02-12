//go:build darwin && !cgo

package sessionbroker

import (
	"context"
	"os/exec"
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
	out, err := exec.Command("stat", "-f", "%Su", "/dev/console").Output()
	if err != nil {
		return nil, nil
	}
	username := strings.TrimSpace(string(out))
	if username == "" || username == "root" || username == "loginwindow" {
		return nil, nil
	}

	return []DetectedSession{
		{
			Username: username,
			Session:  "console",
			Display:  "quartz",
			State:    "active",
		},
	}, nil
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
