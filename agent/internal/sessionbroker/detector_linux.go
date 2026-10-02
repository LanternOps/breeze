//go:build linux

package sessionbroker

import (
	"context"
	"fmt"
	"os/exec"
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
	sessions, _, err := d.listSessionsCounted()
	return sessions, err
}

// listSessionsCounted also reports how many rows it skipped (unparseable
// list rows, unsafe field values); see ListSessionsComplete.
func (d *linuxDetector) listSessionsCounted() ([]DetectedSession, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), detectorCommandTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "loginctl", "list-sessions", "--no-legend", "--no-pager").Output()
	if err != nil {
		return nil, 0, fmt.Errorf("loginctl list-sessions: %w", err)
	}

	var sessions []DetectedSession
	skipped := 0
	scanner := newDetectorScanner(string(out))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		sess, ok := parseLoginctlListLine(line)
		if !ok {
			skipped++
			continue
		}
		sessionID := sess.Session

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
			return nil, skipped, err
		}

		sess, err = sanitizeDetectedSession(sess)
		if err != nil {
			skipped++
			continue
		}

		sessions = append(sessions, sess)
		if len(sessions) >= maxDetectedSessions {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, skipped, fmt.Errorf("parse loginctl list-sessions output: %w", err)
	}

	return sessions, skipped, nil
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
