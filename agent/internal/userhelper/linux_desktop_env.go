package userhelper

// Environment handed to the Linux per-session desktop helper by the root
// agent (#12117). Root starts the helper inside the user's logind session and
// passes three values: the logind session it was started for, a single-use
// spawn ticket the broker redeems at admission, and the socket to dial.
// Untagged so the validation is tested on every host.

import (
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	EnvLinuxDesktopLogindSession = "BREEZE_LOGIND_SESSION"
	EnvLinuxDesktopSpawnTicket   = "BREEZE_SPAWN_TICKET"
	EnvLinuxDesktopIPCSocket     = "BREEZE_IPC_SOCKET"
)

// Sentinels name which variable was bad. Errors never carry the value: the
// ticket is a credential, and the others are untrusted input.
var (
	ErrLinuxDesktopSessionID   = errors.New("invalid " + EnvLinuxDesktopLogindSession)
	ErrLinuxDesktopSpawnTicket = errors.New("invalid " + EnvLinuxDesktopSpawnTicket)
	ErrLinuxDesktopSocket      = errors.New("invalid " + EnvLinuxDesktopIPCSocket)
)

// linuxDesktopSpawnTicketLen is base64url without padding of 32 random bytes.
const linuxDesktopSpawnTicketLen = 43

// maxLinuxDesktopSocketPath keeps the path within a Linux sun_path (108
// bytes, including the terminating NUL).
const maxLinuxDesktopSocketPath = 107

// linuxDesktopSocketRoots are the only directories root hands sockets out
// under. /var/run is a symlink to /run on systemd hosts.
var linuxDesktopSocketRoots = []string{"/run/breeze/", "/var/run/breeze/"}

var (
	linuxDesktopSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)
	linuxDesktopTicketPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

// LinuxDesktopEnv is the validated launch environment of a Linux desktop
// helper. SpawnTicket is a single-use credential: never log it.
type LinuxDesktopEnv struct {
	LogindSessionID string
	SpawnTicket     string
	SocketPath      string
}

// ParseLinuxDesktopEnv reads and validates the launch environment through
// getenv. A returned error wraps one of the ErrLinuxDesktop* sentinels and
// never includes a value read from the environment.
func ParseLinuxDesktopEnv(getenv func(string) string) (LinuxDesktopEnv, error) {
	env := LinuxDesktopEnv{
		LogindSessionID: getenv(EnvLinuxDesktopLogindSession),
		SpawnTicket:     getenv(EnvLinuxDesktopSpawnTicket),
		SocketPath:      getenv(EnvLinuxDesktopIPCSocket),
	}
	if !linuxDesktopSessionIDPattern.MatchString(env.LogindSessionID) {
		return LinuxDesktopEnv{}, fmt.Errorf("%w: want 1-32 ASCII letters or digits", ErrLinuxDesktopSessionID)
	}
	if err := validateLinuxDesktopSpawnTicket(env.SpawnTicket); err != nil {
		return LinuxDesktopEnv{}, err
	}
	if err := validateLinuxDesktopSocketPath(env.SocketPath); err != nil {
		return LinuxDesktopEnv{}, err
	}
	return env, nil
}

func validateLinuxDesktopSpawnTicket(ticket string) error {
	if len(ticket) != linuxDesktopSpawnTicketLen || !linuxDesktopTicketPattern.MatchString(ticket) {
		return fmt.Errorf("%w: want %d base64url characters", ErrLinuxDesktopSpawnTicket, linuxDesktopSpawnTicketLen)
	}
	raw, err := base64.RawURLEncoding.DecodeString(ticket)
	if err != nil || len(raw) != 32 {
		// err is not wrapped: its text quotes input offsets.
		return fmt.Errorf("%w: not a 32-byte base64url value", ErrLinuxDesktopSpawnTicket)
	}
	return nil
}

func validateLinuxDesktopSocketPath(p string) error {
	if p == "" || !filepath.IsAbs(p) {
		return fmt.Errorf("%w: want an absolute path", ErrLinuxDesktopSocket)
	}
	if len(p) > maxLinuxDesktopSocketPath {
		return fmt.Errorf("%w: path too long", ErrLinuxDesktopSocket)
	}
	for i := 0; i < len(p); i++ {
		if p[i] < 0x20 || p[i] == 0x7f {
			return fmt.Errorf("%w: control character in path", ErrLinuxDesktopSocket)
		}
	}
	if filepath.Clean(p) != p {
		return fmt.Errorf("%w: path is not in canonical form", ErrLinuxDesktopSocket)
	}
	for _, root := range linuxDesktopSocketRoots {
		if strings.HasPrefix(p, root) && len(p) > len(root) {
			return nil
		}
	}
	return fmt.Errorf("%w: want a path under /run/breeze or /var/run/breeze", ErrLinuxDesktopSocket)
}
