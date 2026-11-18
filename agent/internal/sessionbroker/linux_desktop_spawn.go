package sessionbroker

// Spawning the Linux per-session desktop helper with systemd-run (#12117).
//
// Root starts the helper as a transient unit in the target user's systemd
// user manager (`systemd-run -M <user>@ --user`). The helper dials the broker
// itself, so nothing here passes file descriptors across the user-manager
// boundary. This file holds the pure parts — argv construction, unit naming,
// input validation and error classification — untagged so every host tests
// them; the exec lives in linux_desktop_spawn_linux.go.

import (
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// linuxDesktopSpawner starts and stops helper units in a user's manager.
type linuxDesktopSpawner interface {
	// Start launches a helper for spec and returns the unit name it used.
	// On error, a non-empty unit names a unit that may nevertheless exist
	// (systemd-run failed after asking for it); the caller stops it.
	Start(ctx context.Context, spec LinuxDesktopSpawnSpec) (unit string, err error)
	// Stop stops unit in username's user manager.
	Stop(ctx context.Context, username, unit string) error
	// ListUnits lists the helper units in username's user manager, bounded
	// to maxLinuxDesktopOrphanUnits. Used for the orphan sweep at start.
	ListUnits(ctx context.Context, username string) ([]string, error)
}

// LinuxDesktopSpawnSpec is everything one helper spawn needs. Every field is
// root's own value; none comes from a helper.
type LinuxDesktopSpawnSpec struct {
	Binding LinuxDesktopBinding
	// Ticket is the single-use spawn ticket. Never logged.
	Ticket string
	// AgentExe is the daemon's own executable, symlinks resolved; it must be
	// one of the broker's allowed helper paths.
	AgentExe string
	// SocketPath is the per-uid broker endpoint the helper dials.
	SocketPath string
	// RuntimeDir is /run/user/<uid>.
	RuntimeDir string
	// WaylandDisplay is the compositor socket name in RuntimeDir.
	WaylandDisplay string
}

const (
	linuxDesktopUnitPrefix = "breeze-desktop-helper-"
	// linuxSystemdMinVersion is the first systemd whose systemd-run reaches a
	// user manager with `-M <user>@ --user`.
	linuxSystemdMinVersion = 248
	// linuxDesktopSpawnTimeout bounds each systemd-run / systemctl call.
	linuxDesktopSpawnTimeout = 10 * time.Second
	// maxSpawnStderrBytes caps how much of a failed command's stderr is kept
	// in the returned error.
	maxSpawnStderrBytes = 512
	// maxLinuxDesktopOrphanUnits bounds the orphan sweep per user.
	maxLinuxDesktopOrphanUnits = 64
	// linuxDesktopChildPath is the whole environment PATH the spawn commands
	// run with; never root's own environment.
	linuxDesktopChildPath = "PATH=/usr/bin:/bin"
)

var (
	// ErrLinuxDesktopSpawnSpecInvalid means root refused to build a spawn
	// from its own inputs; the spec never reaches a command line.
	ErrLinuxDesktopSpawnSpecInvalid = errors.New("linux desktop helper spawn spec invalid")
	// ErrLinuxDesktopSpawnUnsupported means this host's systemd cannot start
	// a unit in a user manager.
	ErrLinuxDesktopSpawnUnsupported = errors.New("systemd on this host cannot start a desktop helper in the user manager")
	// ErrLinuxDesktopUserManagerUnavailable means the target user has no
	// running user manager (or its bus is missing). Never worked around by
	// enabling linger.
	ErrLinuxDesktopUserManagerUnavailable = errors.New("user systemd manager unavailable")
	// ErrLinuxDesktopUnitExists is a unit-name collision. The name is never
	// retried; the next attempt draws a new one.
	ErrLinuxDesktopUnitExists = errors.New("desktop helper unit already exists")

	linuxUsernamePattern       = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$`)
	linuxWaylandDisplayPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	linuxSpawnTicketPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	linuxDesktopUnitPattern    = regexp.MustCompile(`^breeze-desktop-helper-([A-Za-z0-9]{1,32})-g([0-9]{1,20})-[0-9a-f]{8}\.service$`)
)

// validLinuxUsername reports whether s is a safe user name to put in
// `-M <user>@`. root is refused: the helper never runs with root's identity.
func validLinuxUsername(s string) bool {
	return linuxUsernamePattern.MatchString(s) && s != "root" && s != "." && s != ".."
}

// linuxDesktopUnitName names one spawn's transient unit. The random suffix
// keeps a name from ever being reused within a boot even when a generation
// repeats after an agent restart. "" if logindSessionID has an unsafe shape.
func linuxDesktopUnitName(logindSessionID string, gen uint64, rnd [4]byte) string {
	if !validLogindSessionID(logindSessionID) {
		return ""
	}
	return fmt.Sprintf("%s%s-g%d-%02x%02x%02x%02x.service", linuxDesktopUnitPrefix, logindSessionID, gen, rnd[0], rnd[1], rnd[2], rnd[3])
}

// isLinuxDesktopUnitName reports whether unit has exactly the shape
// linuxDesktopUnitName produces. Only such names are ever stopped.
func isLinuxDesktopUnitName(unit string) bool {
	return linuxDesktopUnitPattern.MatchString(unit)
}

// parseLinuxDesktopUnitName returns the logind session id and generation a
// helper unit name carries.
func parseLinuxDesktopUnitName(unit string) (logindSessionID string, gen uint64, ok bool) {
	m := linuxDesktopUnitPattern.FindStringSubmatch(unit)
	if m == nil {
		return "", 0, false
	}
	g, err := strconv.ParseUint(m[2], 10, 64)
	if err != nil {
		return "", 0, false
	}
	return m[1], g, true
}

// errSystemdRunMissing is what a version probe's run reports when the
// systemd-run binary is not installed: a definitive answer.
var errSystemdRunMissing = errors.New("systemd-run not installed")

// systemdVersionProbe checks once per agent run that systemd-run can reach a
// user manager. Only a definitive answer is kept — a parsed version, an
// unparseable one, or a missing binary; a failure to run the probe (a
// cancelled context, a fork error) is reported and asked again next time.
type systemdVersionProbe struct {
	run func(ctx context.Context) (string, error)

	mu   sync.Mutex
	done bool
	err  error
}

func (p *systemdVersionProbe) check(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done {
		return p.err
	}
	out, err := p.run(ctx)
	if err != nil {
		if errors.Is(err, errSystemdRunMissing) {
			p.done, p.err = true, fmt.Errorf("%w: %v", ErrLinuxDesktopSpawnUnsupported, err)
			return p.err
		}
		return fmt.Errorf("systemd-run version probe failed: %w", err)
	}
	p.done = true
	major, perr := systemdMajorVersion(out)
	switch {
	case perr != nil:
		p.err = fmt.Errorf("%w: %v", ErrLinuxDesktopSpawnUnsupported, perr)
	case major < linuxSystemdMinVersion:
		p.err = fmt.Errorf("%w: systemd %d is older than %d", ErrLinuxDesktopSpawnUnsupported, major, linuxSystemdMinVersion)
	}
	return p.err
}

// linuxDesktopSocketPathFor is the per-uid endpoint inside dir.
func linuxDesktopSocketPathFor(dir string, uid uint32) string {
	return filepath.Join(dir, strconv.FormatUint(uint64(uid), 10)+".sock")
}

// validateLinuxDesktopSpawnSpec refuses a spec whose values could change the
// meaning of the systemd-run command line or aim the helper at the wrong
// user, session or endpoint. Errors never include the ticket.
func validateLinuxDesktopSpawnSpec(s LinuxDesktopSpawnSpec) error {
	bad := func(what string) error { return fmt.Errorf("%w: %s", ErrLinuxDesktopSpawnSpecInvalid, what) }
	uid := strconv.FormatUint(uint64(s.Binding.UID), 10)
	switch {
	case s.Binding.UID == 0:
		return bad("uid 0")
	case !validLinuxUsername(s.Binding.Username):
		return bad("user name")
	case !validLogindSessionID(s.Binding.LogindSessionID):
		return bad("logind session id")
	case s.Binding.Generation == 0:
		return bad("generation")
	case !linuxSpawnTicketPattern.MatchString(s.Ticket):
		return bad("ticket shape")
	// path, not filepath, here and in validLinuxDesktopSocketPath: the spec
	// is a Linux path on every host, and on Windows filepath.IsAbs rejects
	// "/usr/..." (no volume) while accepting `C:\...`.
	case !path.IsAbs(s.AgentExe) || path.Clean(s.AgentExe) != s.AgentExe:
		return bad("agent executable path")
	case !validLinuxDesktopSocketPath(s.SocketPath, s.Binding.UID):
		return bad("socket path")
	case s.RuntimeDir != "/run/user/"+uid:
		return bad("runtime dir")
	case !linuxWaylandDisplayPattern.MatchString(s.WaylandDisplay) || s.WaylandDisplay == "." || s.WaylandDisplay == "..":
		return bad("wayland display")
	}
	return nil
}

// validLinuxDesktopSocketPath accepts only <root>/desktop/<uid>.sock under
// /run/breeze or /var/run/breeze — the same prefixes the helper accepts.
func validLinuxDesktopSocketPath(p string, uid uint32) bool {
	if !path.IsAbs(p) || path.Clean(p) != p {
		return false
	}
	want := strconv.FormatUint(uint64(uid), 10) + ".sock"
	if path.Base(p) != want {
		return false
	}
	dir := path.Dir(p)
	return dir == "/run/breeze/desktop" || dir == "/var/run/breeze/desktop"
}

// buildSystemdRunArgv is the exact systemd-run argument list (without the
// binary). No --pipe, --wait or --pty: the helper dials the broker itself.
func buildSystemdRunArgv(spec LinuxDesktopSpawnSpec, unit string) []string {
	b := spec.Binding
	return []string{
		"-M", b.Username + "@", "--user", "--collect", "--quiet",
		"--unit=" + unit, "--service-type=exec",
		"--property=NoNewPrivileges=yes",
		"--setenv=XDG_RUNTIME_DIR=" + spec.RuntimeDir,
		"--setenv=WAYLAND_DISPLAY=" + spec.WaylandDisplay,
		"--setenv=XDG_SESSION_ID=" + b.LogindSessionID,
		"--setenv=XDG_SESSION_TYPE=wayland",
		"--setenv=BREEZE_LOGIND_SESSION=" + b.LogindSessionID,
		// Name only: systemd-run copies the value from its own environment
		// (linuxDesktopSpawnEnv). A command line is readable by every local
		// user through /proc/<pid>/cmdline; an environment only by root and
		// the same uid.
		"--setenv=" + linuxSpawnTicketEnv,
		"--setenv=BREEZE_IPC_SOCKET=" + spec.SocketPath,
		"--", spec.AgentExe, "desktop-helper",
	}
}

const linuxSpawnTicketEnv = "BREEZE_SPAWN_TICKET"

// linuxDesktopSpawnEnv is the whole environment of a spawn command: a fixed
// PATH and locale, never root's own environment, plus the ticket for
// systemd-run to pass through when one is given.
func linuxDesktopSpawnEnv(ticket string) []string {
	env := []string{linuxDesktopChildPath, "LANG=C"}
	if ticket != "" {
		env = append(env, linuxSpawnTicketEnv+"="+ticket)
	}
	return env
}

// buildSystemctlStopArgv stops one helper unit in username's user manager.
func buildSystemctlStopArgv(username, unit string) []string {
	return []string{"-M", username + "@", "--user", "stop", unit}
}

// buildSystemctlListUnitsArgv lists the helper units in username's manager.
func buildSystemctlListUnitsArgv(username string) []string {
	return []string{"-M", username + "@", "--user", "list-units", "--all", "--plain", "--no-legend", "--no-pager", linuxDesktopUnitPrefix + "*"}
}

// spawnStderrForError keeps at most maxSpawnStderrBytes of a command's
// stderr for an error message, with any copy of the ticket removed.
func spawnStderrForError(stderr []byte, ticket string) string {
	s := strings.TrimSpace(string(stderr))
	if ticket != "" {
		s = strings.ReplaceAll(s, ticket, "<redacted>")
	}
	if len(s) > maxSpawnStderrBytes {
		s = s[:maxSpawnStderrBytes]
		for len(s) > 0 && !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

// classifySystemdRunFailure maps systemd-run's stderr to a sentinel, or nil
// when the failure is not one root handles specially.
func classifySystemdRunFailure(stderr string) error {
	switch {
	case strings.Contains(stderr, "already exists") || strings.Contains(stderr, "already loaded"):
		return ErrLinuxDesktopUnitExists
	case strings.Contains(stderr, "Failed to connect to bus"),
		strings.Contains(stderr, "Failed to connect to user scope bus"),
		strings.Contains(stderr, "Failed to connect to user manager"):
		return ErrLinuxDesktopUserManagerUnavailable
	}
	return nil
}

// systemdMajorVersion parses the first line of `systemd-run --version`
// ("systemd 255 (255.4-1ubuntu8)").
func systemdMajorVersion(out string) (int, error) {
	line, _, _ := strings.Cut(out, "\n")
	fields := strings.Fields(line)
	if len(fields) < 2 || fields[0] != "systemd" {
		return 0, fmt.Errorf("unrecognised systemd version output")
	}
	v, err := strconv.Atoi(fields[1])
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("unrecognised systemd version %q", truncateUTF8(fields[1], 32))
	}
	return v, nil
}

// parseLinuxDesktopUnitList reads `systemctl list-units --plain --no-legend`
// output and keeps only well-formed helper unit names, at most
// maxLinuxDesktopOrphanUnits.
func parseLinuxDesktopUnitList(out string) []string {
	var units []string
	for line := range strings.SplitSeq(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !isLinuxDesktopUnitName(fields[0]) {
			continue
		}
		units = append(units, fields[0])
		if len(units) >= maxLinuxDesktopOrphanUnits {
			break
		}
	}
	return units
}
