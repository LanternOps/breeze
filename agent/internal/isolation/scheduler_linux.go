//go:build linux

package isolation

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
	"github.com/breeze-rmm/agent/internal/procspawn"
)

// The units that run the recovery binary without the agent. service/systemd/
// holds the same text as templates (TestStaticIsolationUnitsMatchTemplates).
const (
	linuxBootUnit    = "breeze-isolation.service"
	linuxPollService = "breeze-isolation-poll.service"
	linuxPollTimer   = "breeze-isolation-poll.timer"

	linuxRollbackUnitPrefix = "breeze-isolation-rollback-"
	linuxExpiryUnit         = "breeze-isolation-expire"

	linuxSystemdUnitDir = "/etc/systemd/system"
	// linuxTimerAccuracy overrides systemd's default one-minute coalescing,
	// which could fire the 90 s rollback at 150 s.
	linuxTimerAccuracy = "--timer-property=AccuracySec=1s"
)

// The boot hook loads before the network comes up, so it opts out of default
// dependencies (the pattern distro nftables.service units use) and needs only
// the data directory's filesystem. network-pre.target is passive: without
// Wants= nothing pulls it in and the ordering would be vacuous.
const linuxBootUnitTemplate = `[Unit]
Description=Breeze network isolation boot hook
Documentation=https://github.com/breeze-rmm/breeze
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target
Before=shutdown.target
Wants=network-pre.target
Conflicts=shutdown.target

[Service]
Type=oneshot
ExecStart=@RECOVERY@ boot-apply --data-dir @DATA_DIR@
TimeoutStartSec=90

[Install]
WantedBy=sysinit.target
`

const linuxPollServiceTemplate = `[Unit]
Description=Breeze network isolation expiry check
Documentation=https://github.com/breeze-rmm/breeze

[Service]
Type=oneshot
ExecStart=@RECOVERY@ expire-check --data-dir @DATA_DIR@
TimeoutStartSec=120
`

const linuxPollTimerTemplate = `[Unit]
Description=Breeze network isolation expiry check timer
Documentation=https://github.com/breeze-rmm/breeze

[Timer]
OnBootSec=1min
OnUnitActiveSec=15min
AccuracySec=1min

[Install]
WantedBy=timers.target
`

// linuxUnitPathPattern is what may be substituted into ExecStart and an argv
// that systemd later joins and re-parses: no spaces, quotes or specifiers.
var linuxUnitPathPattern = regexp.MustCompile(`^/[A-Za-z0-9_./+-]+$`)

func renderLinuxUnits(recovery, dataDir string) map[string]string {
	fill := strings.NewReplacer("@RECOVERY@", recovery, "@DATA_DIR@", dataDir)
	return map[string]string{
		linuxBootUnit:    fill.Replace(linuxBootUnitTemplate),
		linuxPollService: fill.Replace(linuxPollServiceTemplate),
		linuxPollTimer:   fill.Replace(linuxPollTimerTemplate),
	}
}

// linuxScheduler arms the recovery timers through systemd. The transient
// rollback and expiry timers live in /run and do not survive a reboot; the
// boot hook and the poll timer are what cover that case.
type linuxScheduler struct {
	dataDir      string
	unitDir      string
	recoveryPath func() (string, error)
	run          func(name string, args ...string) ([]byte, error)
	verify       func(string) error
	selfTest     func(string) error
	now          func() time.Time
}

var _ RecoveryScheduler = (*linuxScheduler)(nil)

// NewPlatformScheduler reads the recovery path from the journal on every call,
// so a recovery artifact rotation also rotates what the units run.
func NewPlatformScheduler(dataDir string) RecoveryScheduler {
	return &linuxScheduler{
		dataDir: dataDir,
		unitDir: linuxSystemdUnitDir,
		recoveryPath: func() (string, error) {
			j, err := journal.Load(journal.Path(dataDir))
			if err != nil {
				return "", err
			}
			return j.RecoveryPath, nil
		},
		run:    runSystemdTool,
		verify: recoveryinstall.VerifyInstalled,
		selfTest: func(path string) error {
			_, err := runLinuxRecovery(15*time.Second, path, "self-test")
			return err
		},
		now: time.Now,
	}
}

func runSystemdTool(name string, args ...string) ([]byte, error) {
	return runLinuxRecovery(30*time.Second, name, args...)
}

func runLinuxRecovery(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

func (s *linuxScheduler) checkedRecoveryPath() (string, error) {
	path, err := s.recoveryPath()
	if err != nil {
		return "", fmt.Errorf("load recovery path: %w", err)
	}
	if strings.TrimSpace(path) == "" {
		return "", errors.New("journal has no recovery path")
	}
	if !linuxUnitPathPattern.MatchString(path) || !linuxUnitPathPattern.MatchString(s.dataDir) {
		return "", fmt.Errorf("recovery path %q or data directory %q cannot go in a systemd unit", path, s.dataDir)
	}
	if err := s.verify(path); err != nil {
		return "", fmt.Errorf("verify recovery executable: %w", err)
	}
	return path, nil
}

// ArmProvisional arms the independent rollback, relative to the monotonic
// clock, keeping the absolute deadline the manager journalled.
func (s *linuxScheduler) ArmProvisional(attemptID string, deadline time.Time) error {
	if !recoveryAttemptPattern.MatchString(attemptID) {
		return fmt.Errorf("invalid isolation rollback attempt ID %q", attemptID)
	}
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	seconds := int64(math.Ceil(deadline.Sub(s.now()).Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	unit := linuxRollbackUnitPrefix + attemptID
	return s.arm(unit, "--on-active="+strconv.FormatInt(seconds, 10)+"s",
		path, "rollback-if-uncommitted", "--data-dir", s.dataDir, "--attempt", attemptID)
}

// ArmExpiry replaces the one-shot expiry timer. Recovery re-reads the journal
// when it fires, so a stale timer cannot release a later generation.
func (s *linuxScheduler) ArmExpiry(_ string, _ int, at time.Time) error {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	// Whole seconds, rounded up: firing just before the deadline would make
	// this one-shot a permanent no-op.
	if at.Nanosecond() != 0 {
		at = at.Truncate(time.Second).Add(time.Second)
	}
	// systemd-run refuses a unit name that exists. Absence is checked by the
	// read-back below, not by this stop's exit status.
	_, _ = s.run("systemctl", "stop", linuxExpiryUnit+".timer")
	_, _ = s.run("systemctl", "reset-failed", linuxExpiryUnit+".timer", linuxExpiryUnit+".service")
	return s.arm(linuxExpiryUnit, "--on-calendar="+at.UTC().Format("2006-01-02 15:04:05")+" UTC",
		path, "expire-check", "--data-dir", s.dataDir)
}

func (s *linuxScheduler) arm(unit, trigger string, argv ...string) error {
	args := append([]string{"--unit=" + unit, trigger, linuxTimerAccuracy, "--collect"}, argv...)
	if _, err := s.run("systemd-run", args...); err != nil {
		return fmt.Errorf("arm %s: %w", unit, err)
	}
	return s.readBackTransient(unit, argv)
}

// readBackTransient confirms the timer is really waiting and that its service
// runs exactly the recovery action: a timer that names something else, or
// nothing, would never fire the rollback.
func (s *linuxScheduler) readBackTransient(unit string, argv []string) error {
	state, err := s.unitState(unit + ".timer")
	if err != nil {
		return fmt.Errorf("read back %s: %w", unit, err)
	}
	if state.load != "loaded" || state.active != "active" {
		return fmt.Errorf("read back %s: timer is %s/%s", unit, state.load, state.active)
	}
	out, err := s.run("systemctl", "show", "--property=LoadState", "--property=ExecStart", unit+".service")
	if err != nil {
		return fmt.Errorf("read back %s: %w", unit, err)
	}
	if !strings.Contains(string(out), "argv[]="+strings.Join(argv, " ")+" ;") {
		return fmt.Errorf("read back %s: recovery action does not match the journal", unit)
	}
	return nil
}

type linuxUnitState struct{ load, active string }

func (s *linuxScheduler) unitState(unit string) (linuxUnitState, error) {
	out, err := s.run("systemctl", "show", "--property=LoadState", "--property=ActiveState", unit)
	if err != nil {
		return linuxUnitState{}, err
	}
	var state linuxUnitState
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		key, value, _ := strings.Cut(scanner.Text(), "=")
		switch key {
		case "LoadState":
			state.load = value
		case "ActiveState":
			state.active = value
		}
	}
	return state, nil
}

// DisarmProvisional stops only the timer. Recovery calls this from inside the
// rollback service: stopping the service would kill the process doing the
// cleanup. --collect drops the service once it exits.
func (s *linuxScheduler) DisarmProvisional(attemptID string) error {
	if !recoveryAttemptPattern.MatchString(attemptID) {
		return fmt.Errorf("invalid isolation rollback attempt ID %q", attemptID)
	}
	return s.stopTimer(linuxRollbackUnitPrefix + attemptID + ".timer")
}

// stopTimer confirms by state rather than by stop's exit status, which is the
// same non-zero for "not loaded" and "could not stop".
func (s *linuxScheduler) stopTimer(timer string) error {
	_, stopErr := s.run("systemctl", "stop", timer)
	state, err := s.unitState(timer)
	if err != nil {
		return fmt.Errorf("confirm %s stopped: %w", timer, err)
	}
	if state.active == "active" || state.active == "activating" {
		if stopErr != nil {
			return fmt.Errorf("stop %s: %w", timer, stopErr)
		}
		return fmt.Errorf("stop %s left it %s", timer, state.active)
	}
	return nil
}

// EnsurePoll installs and enables the boot hook and the fifteen-minute poll.
func (s *linuxScheduler) EnsurePoll() error {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	return s.installUnits(path)
}

func (s *linuxScheduler) installUnits(path string) error {
	changed := false
	for name, content := range renderLinuxUnits(path, s.dataDir) {
		target := filepath.Join(s.unitDir, name)
		if existing, err := os.ReadFile(target); err == nil && string(existing) == content {
			continue
		}
		if err := writeLinuxUnit(target, content); err != nil {
			return fmt.Errorf("write %s: %w", name, err)
		}
		changed = true
	}
	if changed {
		if _, err := s.run("systemctl", "daemon-reload"); err != nil {
			return err
		}
	}
	if _, err := s.run("systemctl", "enable", linuxBootUnit, linuxPollTimer); err != nil {
		return err
	}
	if _, err := s.run("systemctl", "start", linuxPollTimer); err != nil {
		return err
	}
	return s.readBackUnits(path)
}

func writeLinuxUnit(target, content string) error {
	tmp, err := os.CreateTemp(filepath.Dir(target), ".breeze-isolation-unit-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	_, writeErr := tmp.WriteString(content)
	syncErr := tmp.Sync()
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	if err := os.Chmod(name, 0o644); err != nil {
		return err
	}
	return os.Rename(name, target)
}

func (s *linuxScheduler) readBackUnits(path string) error {
	for name, content := range renderLinuxUnits(path, s.dataDir) {
		got, err := os.ReadFile(filepath.Join(s.unitDir, name))
		if err != nil {
			return fmt.Errorf("read back %s: %w", name, err)
		}
		if string(got) != content {
			return fmt.Errorf("read back %s: unit does not match the journal", name)
		}
	}
	for _, unit := range []string{linuxBootUnit, linuxPollTimer} {
		if _, err := s.run("systemctl", "is-enabled", unit); err != nil {
			return fmt.Errorf("%s is not enabled: %w", unit, err)
		}
	}
	if _, err := s.run("systemctl", "is-active", linuxPollTimer); err != nil {
		return fmt.Errorf("%s is not active: %w", linuxPollTimer, err)
	}
	return nil
}

// Ready checks the artifact, the installed units and the self-test without
// changing anything.
func (s *linuxScheduler) Ready() (bool, string) {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return false, err.Error()
	}
	if err := s.readBackUnits(path); err != nil {
		return false, err.Error()
	}
	if err := s.selfTest(path); err != nil {
		return false, fmt.Sprintf("recovery self-test: %v", err)
	}
	return true, ""
}

// isOwnedLinuxTimer recognises only the exact names this scheduler creates.
func isOwnedLinuxTimer(name string) bool {
	switch name {
	case linuxPollTimer, linuxExpiryUnit + ".timer":
		return true
	}
	attempt, ok := strings.CutPrefix(name, linuxRollbackUnitPrefix)
	if !ok {
		return false
	}
	attempt, ok = strings.CutSuffix(attempt, ".timer")
	return ok && recoveryAttemptPattern.MatchString(attempt)
}

// RemoveAll stops every owned timer and removes the static units. It runs from
// inside these units (recovery cleaning up after itself), so it stops timers
// only, never a service, and it returns an error while any timer is still
// active: recovery then stays armed rather than reporting a clean removal.
func (s *linuxScheduler) RemoveAll() error {
	out, err := s.run("systemctl", "list-units", "--all", "--plain", "--no-legend", "--no-pager", "--type=timer", "breeze-isolation-*")
	if err != nil {
		return fmt.Errorf("list isolation timers: %w", err)
	}
	var failures []error
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) > 0 && isOwnedLinuxTimer(fields[0]) {
			if err := s.stopTimer(fields[0]); err != nil {
				failures = append(failures, err)
			}
		}
	}
	if len(failures) > 0 {
		// A timer is still live: keep the boot hook and the poll as well, so
		// recovery stays armed across a reboot until a later removal succeeds.
		return errors.Join(failures...)
	}
	var enabled []string
	for _, unit := range []string{linuxBootUnit, linuxPollTimer} {
		if _, err := os.Lstat(filepath.Join(s.unitDir, unit)); err == nil {
			enabled = append(enabled, unit)
		}
	}
	if len(enabled) > 0 {
		if _, err := s.run("systemctl", append([]string{"disable"}, enabled...)...); err != nil {
			failures = append(failures, err)
		}
	}
	removed := false
	for _, unit := range []string{linuxBootUnit, linuxPollService, linuxPollTimer} {
		err := os.Remove(filepath.Join(s.unitDir, unit))
		switch {
		case err == nil:
			removed = true
		case !errors.Is(err, os.ErrNotExist):
			failures = append(failures, err)
		}
	}
	if removed {
		if _, err := s.run("systemctl", "daemon-reload"); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
