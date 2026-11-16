//go:build linux

package wayland

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
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
	return procspawn.Command(lookBin("loginctl"), args...).Output()
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

func lookBin(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return "/usr/bin/" + name
}

// CaptureSupported reports that the active Wayland session can use this
// capture path. It does not open a portal session. A Wayland login whose
// compositor has no RemoteDesktop portal, whose gstreamer has no pipewiresrc,
// or whose systemd-run lacks --pipe/--collect is not capturable.
func CaptureSupported() bool {
	s, err := cachedSession()
	if err != nil || !s.wayland || !s.active || s.name == "" || !gstInstalled() {
		return false
	}
	return probeReady(s.name)
}

var probeCache struct {
	mu   sync.Mutex
	at   time.Time
	user string
	ok   bool
}

func probeReady(user string) bool {
	probeCache.mu.Lock()
	if probeCache.user == user && time.Since(probeCache.at) < 2*time.Minute {
		ok := probeCache.ok
		probeCache.mu.Unlock()
		return ok
	}
	probeCache.mu.Unlock()

	sysOK := systemdPipe()
	pwOK := pipewireSrc()
	portalOK := sysOK && pwOK && remoteDesktopPortal(user)
	ok := sysOK && pwOK && portalOK
	if !ok {
		slog.Info("wayland capture unavailable",
			"systemd_pipe", sysOK, "pipewiresrc", pwOK, "remote_desktop", portalOK)
	}
	probeCache.mu.Lock()
	probeCache.at = time.Now()
	probeCache.user = user
	probeCache.ok = ok
	probeCache.mu.Unlock()
	return ok
}

func systemdHelpSupportsPipe(help string) bool {
	return strings.Contains(help, "--pipe") && strings.Contains(help, "--collect")
}

func systemdPipe() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, lookBin("systemd-run"), "--help").CombinedOutput()
	if err != nil && len(out) == 0 {
		return false
	}
	return systemdHelpSupportsPipe(string(out))
}

func pipewireSrc() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := procspawn.CommandContext(ctx, lookBin("gst-inspect-1.0"), "pipewiresrc").Run()
	return err == nil
}

func remoteDesktopPortal(user string) bool {
	if !validUser(user) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, lookBin("busctl"),
		"--user", "-M", user+"@", "introspect",
		"org.freedesktop.portal.Desktop",
		"/org/freedesktop/portal/desktop",
		"org.freedesktop.portal.RemoteDesktop").CombinedOutput()
	return err == nil && len(strings.TrimSpace(string(out))) > 0
}
