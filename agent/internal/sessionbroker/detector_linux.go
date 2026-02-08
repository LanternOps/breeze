//go:build linux

package sessionbroker

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type linuxDetector struct{}

// NewSessionDetector creates a Linux session detector.
// Uses loginctl (systemd-logind) for session enumeration.
func NewSessionDetector() SessionDetector {
	return &linuxDetector{}
}

func (d *linuxDetector) ListSessions() ([]DetectedSession, error) {
	out, err := exec.Command("loginctl", "list-sessions", "--no-legend", "--no-pager").Output()
	if err != nil {
		return nil, fmt.Errorf("loginctl list-sessions: %w", err)
	}

	var sessions []DetectedSession
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}

		sessionID := fields[0]
		uid, _ := strconv.ParseUint(fields[1], 10, 32)
		username := fields[2]

		// Get session details
		sess := DetectedSession{
			UID:      uint32(uid),
			Username: username,
			Session:  sessionID,
			State:    "active",
		}

		// Query session properties
		if propOut, err := exec.Command("loginctl", "show-session", sessionID,
			"--property=Type,Remote,Display,Seat,State").Output(); err == nil {
			for _, propLine := range strings.Split(string(propOut), "\n") {
				parts := strings.SplitN(strings.TrimSpace(propLine), "=", 2)
				if len(parts) != 2 {
					continue
				}
				switch parts[0] {
				case "Type":
					if parts[1] == "x11" || parts[1] == "wayland" || parts[1] == "mir" {
						sess.Display = parts[1]
					}
				case "Remote":
					sess.IsRemote = parts[1] == "yes"
				case "Seat":
					sess.Seat = parts[1]
				case "State":
					sess.State = parts[1]
				}
			}
		}

		sessions = append(sessions, sess)
	}

	return sessions, nil
}

func (d *linuxDetector) WatchSessions(ctx context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent, 16)

	go func() {
		defer close(ch)

		// Track known sessions
		known := make(map[string]DetectedSession)

		// Populate initial state
		if sessions, err := d.ListSessions(); err == nil {
			for _, s := range sessions {
				known[s.Session] = s
			}
		}

		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				current, err := d.ListSessions()
				if err != nil {
					continue
				}

				currentMap := make(map[string]DetectedSession)
				for _, s := range current {
					currentMap[s.Session] = s
				}

				// Detect new sessions
				for id, s := range currentMap {
					if _, exists := known[id]; !exists {
						ch <- SessionEvent{
							Type:     SessionLogin,
							UID:      s.UID,
							Username: s.Username,
							Session:  s.Session,
							IsRemote: s.IsRemote,
							Display:  s.Display,
						}
					}
				}

				// Detect removed sessions
				for id, s := range known {
					if _, exists := currentMap[id]; !exists {
						ch <- SessionEvent{
							Type:     SessionLogout,
							UID:      s.UID,
							Username: s.Username,
							Session:  s.Session,
							IsRemote: s.IsRemote,
						}
					}
				}

				known = currentMap
			}
		}
	}()

	return ch
}
