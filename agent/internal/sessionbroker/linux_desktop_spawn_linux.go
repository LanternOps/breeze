//go:build linux

package sessionbroker

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
	"github.com/breeze-rmm/agent/internal/procspawn"
)

// systemdRunSpawner starts the Linux desktop helper as a transient unit in
// the target user's systemd user manager. Binaries come from the fixed
// system directories, never from PATH, and every child runs with a fixed
// minimal environment through procspawn.
type systemdRunSpawner struct {
	probe *systemdVersionProbe
}

func newSystemdRunSpawner() *systemdRunSpawner {
	return &systemdRunSpawner{probe: &systemdVersionProbe{run: runSystemdRunVersion}}
}

// runSystemdRunVersion runs `systemd-run --version`.
func runSystemdRunVersion(ctx context.Context) (string, error) {
	bin, err := linuxsession.ResolveSystemBinary("systemd-run")
	if err != nil {
		return "", fmt.Errorf("%w: %v", errSystemdRunMissing, err)
	}
	out, _, err := runSpawnCommand(ctx, bin, []string{"--version"}, "")
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (s *systemdRunSpawner) Start(ctx context.Context, spec LinuxDesktopSpawnSpec) (string, error) {
	if err := validateLinuxDesktopSpawnSpec(spec); err != nil {
		return "", err
	}
	if err := s.probe.check(ctx); err != nil {
		return "", err
	}
	// A user manager that is running has its bus here. Its presence does not
	// prove a graphical session (logind does that); its absence proves there
	// is nothing to start a unit in. Linger is never enabled to create one.
	bus := spec.RuntimeDir + "/bus"
	if fi, err := os.Lstat(bus); err != nil || fi.Mode()&os.ModeSocket == 0 {
		return "", fmt.Errorf("%w: no user bus for uid %d", ErrLinuxDesktopUserManagerUnavailable, spec.Binding.UID)
	}
	var rnd [4]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return "", fmt.Errorf("unit name randomness unavailable: %w", err)
	}
	unit := linuxDesktopUnitName(spec.Binding.LogindSessionID, spec.Binding.Generation, rnd)
	if unit == "" {
		return "", fmt.Errorf("%w: unit name", ErrLinuxDesktopSpawnSpecInvalid)
	}
	bin, err := linuxsession.ResolveSystemBinary("systemd-run")
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrLinuxDesktopSpawnUnsupported, err)
	}
	argv := buildSystemdRunArgv(spec, unit)
	_, stderr, err := runSpawnCommand(ctx, bin, argv, spec.Ticket)
	if err != nil {
		msg := spawnStderrForError(stderr, spec.Ticket)
		if sentinel := classifySystemdRunFailure(msg); sentinel != nil {
			// A name collision means the unit is someone else's: never
			// report it for stopping.
			if errors.Is(sentinel, ErrLinuxDesktopUnitExists) {
				return "", fmt.Errorf("%w: %s", sentinel, msg)
			}
			return unit, fmt.Errorf("%w: %s", sentinel, msg)
		}
		log.Warn("systemd-run failed to start the Linux desktop helper",
			"argv", argv, "uid", spec.Binding.UID, "error", err.Error(), "stderr", msg)
		// The unit may exist although systemd-run failed (e.g. its deadline
		// expired after the request reached the manager).
		return unit, fmt.Errorf("systemd-run: %w: %s", err, msg)
	}
	return unit, nil
}

func (s *systemdRunSpawner) Stop(ctx context.Context, username, unit string) error {
	if !validLinuxUsername(username) || !isLinuxDesktopUnitName(unit) {
		return fmt.Errorf("%w: stop target", ErrLinuxDesktopSpawnSpecInvalid)
	}
	bin, err := linuxsession.ResolveSystemBinary("systemctl")
	if err != nil {
		return err
	}
	_, stderr, err := runSpawnCommand(ctx, bin, buildSystemctlStopArgv(username, unit), "")
	if err != nil {
		return fmt.Errorf("systemctl stop %s: %w: %s", unit, err, spawnStderrForError(stderr, ""))
	}
	return nil
}

func (s *systemdRunSpawner) ListUnits(ctx context.Context, username string) ([]string, error) {
	if !validLinuxUsername(username) {
		return nil, fmt.Errorf("%w: user name", ErrLinuxDesktopSpawnSpecInvalid)
	}
	bin, err := linuxsession.ResolveSystemBinary("systemctl")
	if err != nil {
		return nil, err
	}
	out, stderr, err := runSpawnCommand(ctx, bin, buildSystemctlListUnitsArgv(username), "")
	if err != nil {
		msg := spawnStderrForError(stderr, "")
		if sentinel := classifySystemdRunFailure(msg); sentinel != nil {
			return nil, fmt.Errorf("%w: %s", sentinel, msg)
		}
		return nil, fmt.Errorf("systemctl list-units: %w: %s", err, msg)
	}
	return parseLinuxDesktopUnitList(string(out)), nil
}

// maxSpawnCommandOutput bounds stdout and stderr kept from one command.
const maxSpawnCommandOutput = 64 << 10

// runSpawnCommand runs bin with argv under a linuxDesktopSpawnTimeout
// deadline, the fixed minimal environment (plus ticket, when non-empty, for
// systemd-run to pass through) and bounded output buffers. Callers scrub
// stderr with spawnStderrForError.
func runSpawnCommand(ctx context.Context, bin string, argv []string, ticket string) (stdout, stderr []byte, err error) {
	ctx, cancel := context.WithTimeout(ctx, linuxDesktopSpawnTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, bin, argv...)
	cmd.Env = linuxDesktopSpawnEnv(ticket)
	cmd.Dir = "/"
	var out, errOut cappedBuffer
	out.max, errOut.max = maxSpawnCommandOutput, maxSpawnCommandOutput
	cmd.Stdout, cmd.Stderr = &out, &errOut
	runErr := cmd.Run()
	if runErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			runErr = fmt.Errorf("%w (%v)", runErr, ctxErr)
		}
	}
	return out.Bytes(), errOut.Bytes(), runErr
}

// cappedBuffer keeps the first max bytes written and discards the rest, so
// a misbehaving child cannot grow root's memory.
type cappedBuffer struct {
	bytes.Buffer
	max int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.Len(); room > 0 {
		if len(p) > room {
			c.Buffer.Write(p[:room])
		} else {
			c.Buffer.Write(p)
		}
	}
	return len(p), nil
}
