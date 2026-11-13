//go:build linux

package wayland

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type userSession struct {
	name    string
	wayland bool
	active  bool
	locked  bool
}

var sessionCache struct {
	mu  sync.Mutex
	at  time.Time
	s   userSession
	err error
}

func loginctl(args ...string) ([]byte, error) {
	bin, err := exec.LookPath("loginctl")
	if err != nil {
		bin = "/usr/bin/loginctl"
	}
	return exec.Command(bin, args...).Output()
}

func lookupSession() (userSession, error) {
	out, err := loginctl("list-sessions", "--no-legend")
	if err != nil {
		return userSession{}, fmt.Errorf("loginctl list-sessions: %w", err)
	}
	var best userSession
	found := false
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		raw, err := loginctl("show-session", fields[0],
			"-p", "Name", "-p", "Type", "-p", "Active", "-p", "LockedHint", "-p", "Class")
		if err != nil {
			continue
		}
		kv := map[string]string{}
		for _, row := range strings.Split(string(raw), "\n") {
			k, v, ok := strings.Cut(row, "=")
			if ok {
				kv[k] = v
			}
		}
		if class := kv["Class"]; class != "" && class != "user" {
			continue
		}
		s := userSession{
			name:    kv["Name"],
			wayland: kv["Type"] == "wayland",
			active:  kv["Active"] == "yes",
			locked:  kv["LockedHint"] == "yes",
		}
		if !s.wayland || s.name == "" {
			continue
		}
		if !found || sessionScore(s) > sessionScore(best) {
			best = s
			found = true
		}
	}
	if !found {
		return userSession{}, nil
	}
	return best, nil
}

func sessionScore(s userSession) int {
	n := 0
	if s.active {
		n += 2
	}
	if !s.locked {
		n++
	}
	return n
}

func cachedSession() (userSession, error) {
	sessionCache.mu.Lock()
	defer sessionCache.mu.Unlock()
	if time.Since(sessionCache.at) < 2*time.Second {
		return sessionCache.s, sessionCache.err
	}
	s, err := lookupSession()
	sessionCache.at = time.Now()
	sessionCache.s = s
	sessionCache.err = err
	return s, err
}

// IsGraphical reports an active Wayland login that this agent can capture
// (PipeWire via gstreamer). It does not open a portal session, so the
// heartbeat can advertise the desktop without showing a share dialog.
func IsGraphical() bool {
	if !gstInstalled() {
		return false
	}
	s, err := cachedSession()
	return err == nil && s.wayland && s.active && s.name != ""
}

func gstInstalled() bool {
	if _, err := exec.LookPath("gst-launch-1.0"); err == nil {
		return true
	}
	_, err := os.Stat("/usr/bin/gst-launch-1.0")
	return err == nil
}
