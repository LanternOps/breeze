//go:build linux

package x11

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/logging"
)

// ResolveDisplayTargets enumerates X sockets under /tmp/.X11-unix and Wayland
// sockets under /run/user/<uid>, resolving each X display to its owner and
// Xauthority. Results are ranked: active x11 first, then any x11, then wayland.
func ResolveDisplayTargets() ([]DisplayTarget, error) {
	sessions := loginctlDetails() // map[display]loginctlSession-ish, best-effort
	var targets []DisplayTarget

	// X11 displays from /tmp/.X11-unix/X<N>
	if entries, err := os.ReadDir("/tmp/.X11-unix"); err == nil {
		for _, e := range entries {
			name := e.Name() // "X10"
			if !strings.HasPrefix(name, "X") {
				continue
			}
			num := strings.TrimPrefix(name, "X")
			if _, err := strconv.Atoi(num); err != nil {
				continue
			}
			display := ":" + num
			t := DisplayTarget{Display: display, SessionType: "x11"}
			if pid, argv, uid, ok := findXServerProc(num); ok {
				t.OwnerUID = uid
				t.XauthPath = resolveXauthPath(parseAuthArg(argv), uid, pid)
			}
			if s, ok := sessions[display]; ok {
				t.OwnerName = s.user
				t.Active = s.active
				if t.OwnerUID == 0 {
					t.OwnerUID = s.uid
				}
			}
			if t.OwnerName == "" && t.OwnerUID > 0 {
				if u := lookupUsername(t.OwnerUID); u != "" {
					t.OwnerName = u
				}
			}
			if t.XauthPath == "" {
				t.XauthPath = defaultXauthGuess(t.OwnerUID, t.OwnerName)
			}
			targets = append(targets, t)
		}
	}

	// Wayland sockets — reported but not attachable in Phase 1.
	if userDirs, err := os.ReadDir("/run/user"); err == nil {
		for _, ud := range userDirs {
			uid, err := strconv.Atoi(ud.Name())
			if err != nil {
				continue
			}
			matches, _ := filepath.Glob(filepath.Join("/run/user", ud.Name(), "wayland-*"))
			// Exclude .lock files.
			for _, m := range matches {
				if strings.HasSuffix(m, ".lock") {
					continue
				}
				targets = append(targets, DisplayTarget{
					Display:     filepath.Base(m),
					OwnerUID:    uid,
					OwnerName:   lookupUsername(uid),
					SessionType: "wayland",
				})
				break
			}
		}
	}

	if len(targets) == 0 {
		return nil, ErrNoDisplay
	}
	sort.SliceStable(targets, func(i, j int) bool {
		return rank(targets[i]) < rank(targets[j])
	})
	return targets, nil
}

// SelectX11Target returns the best attachable X11 target.
func SelectX11Target() (DisplayTarget, error) {
	targets, err := ResolveDisplayTargets()
	if err != nil {
		return DisplayTarget{}, err
	}
	sawWayland := false
	for _, t := range targets {
		if t.SessionType == "x11" && t.XauthPath != "" {
			return t, nil
		}
		if t.SessionType == "wayland" {
			sawWayland = true
		}
	}
	if sawWayland {
		return DisplayTarget{}, ErrWaylandUnsupported
	}
	return DisplayTarget{}, ErrNoDisplay
}

func rank(t DisplayTarget) int {
	switch {
	case t.SessionType == "x11" && t.Active:
		return 0
	case t.SessionType == "x11":
		return 1
	default:
		return 2
	}
}

// findXServerProc scans /proc for the Xorg/X/Xwayland process owning display :N,
// returning its pid, argv, and uid.
func findXServerProc(displayNum string) (pid int, argv []string, uid int, ok bool) {
	return findXServerProcAt("/proc", displayNum)
}

func findXServerProcAt(procRoot, displayNum string) (pid int, argv []string, uid int, ok bool) {
	procs, err := os.ReadDir(procRoot)
	if err != nil {
		return 0, nil, 0, false
	}
	want := ":" + displayNum
	type xServerProc struct {
		pid  int
		argv []string
		uid  int
	}
	var candidates []xServerProc
	for _, p := range procs {
		pidN, err := strconv.Atoi(p.Name())
		if err != nil {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join(procRoot, p.Name(), "cmdline"))
		if err != nil {
			continue
		}
		args := splitCmdline(cmdline)
		if len(args) == 0 {
			continue
		}
		base := filepath.Base(args[0])
		if base != "Xorg" && base != "X" && base != "Xwayland" {
			continue
		}
		hasDisplay := false
		for _, a := range args {
			if a == want {
				hasDisplay = true
				break
			}
		}
		var st struct{ uid int }
		if fi, err := os.Stat(filepath.Join(procRoot, p.Name())); err == nil {
			st.uid = statUID(fi)
		}
		if hasDisplay {
			return pidN, args, st.uid, true
		}
		candidates = append(candidates, xServerProc{pidN, args, st.uid})
	}

	// GDM uses -displayfd instead of a literal :N argument, so match the X
	// server by the socket it listens on. Unix sockets are per network
	// namespace: read each candidate's own /proc/<pid>/net/unix.
	var lastErr error
	skipped := 0
	for _, c := range candidates {
		unix, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(c.pid), "net", "unix"))
		if err != nil {
			lastErr = err
			skipped++
			continue
		}
		inodes := parseXSocketInodes(string(unix), displayNum)
		if len(inodes) == 0 {
			continue
		}
		fdRoot := filepath.Join(procRoot, strconv.Itoa(c.pid), "fd")
		fds, err := os.ReadDir(fdRoot)
		if err != nil {
			lastErr = err
			skipped++
			continue
		}
		var links []string
		var fdErr error
		for _, fd := range fds {
			if link, err := os.Readlink(filepath.Join(fdRoot, fd.Name())); err == nil {
				links = append(links, link)
			} else if !errors.Is(err, fs.ErrNotExist) {
				// A descriptor closing between ReadDir and Readlink is normal
				// (ENOENT); any other failure may hide the matching socket.
				fdErr = err
			}
		}
		if hasXSocket(links, inodes) {
			return c.pid, c.argv, c.uid, true
		}
		if fdErr != nil {
			lastErr = fdErr
			skipped++
		}
	}
	if skipped > 0 {
		logging.L("desktop.x11").Debug("no X server matched the display socket; some candidates could not be read",
			"display", want, "unreadable", skipped, "candidates", len(candidates), "error", lastErr.Error())
	}
	return 0, nil, 0, false
}

func splitCmdline(b []byte) []string {
	parts := strings.Split(string(b), "\x00")
	out := parts[:0]
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// resolveXauthPath applies the resolution order: X server -auth arg → session
// leader environ XAUTHORITY → ~owner/.Xauthority → /run/user/<uid>/gdm/Xauthority.
func resolveXauthPath(authArg string, uid, pid int) string {
	if authArg != "" && filepath.IsAbs(authArg) {
		if _, err := os.Stat(authArg); err == nil {
			return authArg
		}
	}
	if pid > 0 {
		if x := environXAuthority(pid); x != "" {
			if _, err := os.Stat(x); err == nil {
				return x
			}
		}
	}
	return defaultXauthGuess(uid, "")
}

func environXAuthority(pid int) string {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ"))
	if err != nil {
		return ""
	}
	for _, kv := range strings.Split(string(b), "\x00") {
		if strings.HasPrefix(kv, "XAUTHORITY=") {
			return strings.TrimPrefix(kv, "XAUTHORITY=")
		}
	}
	return ""
}

func defaultXauthGuess(uid int, name string) string {
	candidates := []string{}
	if uid > 0 {
		candidates = append(candidates,
			filepath.Join("/run/user", strconv.Itoa(uid), "gdm", "Xauthority"),
			filepath.Join("/run/user", strconv.Itoa(uid), ".mutter-Xwaylandauth"),
		)
	}
	if name != "" {
		candidates = append(candidates, filepath.Join("/home", name, ".Xauthority"))
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// loginctlDetails returns per-display session info keyed by ":N". Best-effort.
func loginctlDetails() map[string]struct {
	user   string
	uid    int
	active bool
} {
	result := map[string]struct {
		user   string
		uid    int
		active bool
	}{}
	out, err := exec.Command("loginctl", "list-sessions", "--no-legend", "--no-pager").Output()
	if err != nil {
		return result
	}
	for _, s := range parseLoginctlSessions(string(out)) {
		det, err := exec.Command("loginctl", "show-session", s.id,
			"-p", "Display", "-p", "Type", "-p", "Active", "-p", "State").Output()
		if err != nil {
			continue
		}
		var display, active string
		for _, line := range strings.Split(string(det), "\n") {
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			switch k {
			case "Display":
				display = v
			case "Active":
				active = v
			}
		}
		if display == "" {
			continue
		}
		result[display] = struct {
			user   string
			uid    int
			active bool
		}{user: s.user, uid: s.uid, active: active == "yes"}
	}
	return result
}
