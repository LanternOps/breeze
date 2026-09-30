//go:build linux

package sessionbroker

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// logindSessionProperties is the property list asked of `loginctl
// show-session`; applyLogindSessionProperties (logind_props.go) parses it.
const logindSessionProperties = "--property=Type,Remote,Display,Seat,State,Class,LockedHint,IdleHint,IdleSinceHint"

type linuxDetector struct{}

// NewSessionDetector creates a Linux session detector.
// Uses loginctl (systemd-logind) for session enumeration.
func NewSessionDetector() SessionDetector {
	return &linuxDetector{}
}

func (d *linuxDetector) ListSessions() ([]DetectedSession, error) {
	ctx, cancel := context.WithTimeout(context.Background(), detectorCommandTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "loginctl", "list-sessions", "--no-legend", "--no-pager").Output()
	if err != nil {
		return nil, fmt.Errorf("loginctl list-sessions: %w", err)
	}

	var sessions []DetectedSession
	scanner := newDetectorScanner(string(out))
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
		uid, err := strconv.ParseUint(fields[1], 10, 32)
		if err != nil {
			continue // skip sessions with unparseable UID
		}
		username := fields[2]

		// Get session details
		sess := DetectedSession{
			UID:      uint32(uid),
			Username: username,
			Session:  sessionID,
			State:    "active",
		}

		// Query session properties. A failed query leaves State/Display/Seat
		// at their defaults; flag it so callers never read those defaults as
		// "nobody is at a desktop" (the consent gate's occupancy check).
		propCtx, propCancel := context.WithTimeout(context.Background(), detectorCommandTimeout)
		propOut, propErr := exec.CommandContext(propCtx, "loginctl", "show-session", sessionID,
			logindSessionProperties).Output()
		propCancel()
		if propErr != nil {
			sess.PropertiesUnknown = true
		} else if err := applyLogindSessionProperties(&sess, string(propOut), time.Now()); err != nil {
			return nil, err
		}

		sess, err = sanitizeDetectedSession(sess)
		if err != nil {
			continue
		}

		sessions = append(sessions, sess)
		if len(sessions) >= maxDetectedSessions {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("parse loginctl list-sessions output: %w", err)
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
