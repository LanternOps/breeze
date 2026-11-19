//go:build darwin

package isolation

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/procspawn"
)

// The macOS recovery timers are system-domain LaunchDaemons that run the
// separately installed breeze-isolation-recovery binary, never the agent (spec
// §3.6, OD3b). agent/service/launchd/com.breeze.isolation*.plist are the
// reference copies; scheduler_darwin_test.go holds these renderings to them.
const (
	// pollLabel runs at load (boot) and every 15 minutes: boot re-apply and
	// the expiry backstop.
	pollLabel = "com.breeze.isolation"
	// rollbackLabel polls every 15 s while an apply is provisional. launchd
	// has no one-shot timer with seconds precision, so the recovery binary
	// checks the attempt's own deadline and only rolls back once it passed.
	rollbackLabel = "com.breeze.isolation.rollback"
	// expireLabel fires once at expiresAt, rewritten on every extend.
	expireLabel = "com.breeze.isolation.expire"

	launchDaemonsDir   = "/Library/LaunchDaemons"
	recoveryLogPath    = "/Library/Logs/Breeze/isolation-recovery.log"
	launchctlBinary    = "/bin/launchctl"
	launchctlNotLoaded = 113
	// bootoutWait bounds how long a booted-out job may take to leave launchd:
	// bootout returns before the old instance is gone (#10868).
	bootoutPolls    = 30
	bootoutPollStep = 500 * time.Millisecond
)

// darwinScheduler keeps every OS boundary injectable, so its decisions are
// tested without launchd. Callers hold the machine lock.
type darwinScheduler struct {
	dataDir   string
	daemonDir string
	// launchctl returns the combined output and exit code; err only when the
	// command could not run at all.
	launchctl       func(args ...string) (string, int, error)
	verifySignature func(string) error
	selfTest        func(string) error
	chown           func(string) error
	location        func() *time.Location
	// selfLabel is the launchd job this process is running as, if any:
	// launchd names it in XPC_SERVICE_NAME.
	selfLabel func() string
	sleep     func(time.Duration)
}

var _ RecoveryScheduler = (*darwinScheduler)(nil)

// NewPlatformScheduler supplies the macOS recovery LaunchDaemons. The recovery
// path is read afresh from the journal on every call, so a rotation of the
// recovery artifact also rotates the jobs.
func NewPlatformScheduler(dataDir string) RecoveryScheduler { return newDarwinScheduler(dataDir) }

func newDarwinScheduler(dataDir string) *darwinScheduler {
	return &darwinScheduler{
		dataDir:         dataDir,
		daemonDir:       launchDaemonsDir,
		launchctl:       runLaunchctl,
		verifySignature: verifyRecoveryCodeSignature,
		selfTest: func(path string) error {
			_, _, err := runBounded(15*time.Second, path, "self-test")
			return err
		},
		chown:     func(path string) error { return os.Chown(path, 0, 0) },
		location:  func() *time.Location { return time.Local },
		selfLabel: func() string { return os.Getenv("XPC_SERVICE_NAME") },
		sleep:     time.Sleep,
	}
}

func runBounded(timeout time.Duration, binary string, args ...string) (string, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, binary, args...).CombinedOutput()
	var exit *exec.ExitError
	if errors.As(err, &exit) && ctx.Err() == nil {
		return string(out), exit.ExitCode(), fmt.Errorf("%s %s exited %d: %s", binary, strings.Join(args, " "), exit.ExitCode(), strings.TrimSpace(string(out)))
	}
	if err != nil {
		return string(out), -1, fmt.Errorf("%s %s: %w", binary, strings.Join(args, " "), err)
	}
	return string(out), 0, nil
}

func runLaunchctl(args ...string) (string, int, error) {
	out, code, err := runBounded(30*time.Second, launchctlBinary, args...)
	if code > 0 {
		return out, code, nil
	}
	return out, code, err
}

// verifyRecoveryCodeSignature checks the recovery binary's signature. Which
// signing identity it must carry is pinned by the release-signing work that
// also ships the binary (Todd gate); until then nothing distributes one.
func verifyRecoveryCodeSignature(path string) error {
	_, _, err := runBounded(30*time.Second, "/usr/bin/codesign", "--verify", "--strict", path)
	return err
}

// expiryCalendarTime is a launchd StartCalendarInterval: local wall time, whole
// minutes, no year. The job is rewritten on every extend and removed at the end.
type expiryCalendarTime struct{ Month, Day, Hour, Minute int }

// expiryCalendar converts expiresAt to the local wall minute that fires at or
// after it. When the clock falls back, a wall minute happens twice and launchd
// fires at the first: for an instant in the repeat that is up to an hour early,
// a wasted one-shot. So such an instant moves to the first wall minute after the
// repeat, and the 15-minute poll covers the difference.
func expiryCalendar(at time.Time, loc *time.Location) expiryCalendarTime {
	t := at.In(loc)
	if !t.Equal(t.Truncate(time.Minute)) {
		t = t.Truncate(time.Minute).Add(time.Minute)
	}
	wall := func(x time.Time) [4]int {
		x = x.In(loc)
		return [4]int{int(x.Month()), x.Day(), x.Hour(), x.Minute()}
	}
	for step := 0; step < 3*60; step++ {
		repeat := false
		for _, earlier := range []time.Duration{30 * time.Minute, time.Hour, 2 * time.Hour} {
			repeat = repeat || wall(t.Add(-earlier)) == wall(t)
		}
		if !repeat {
			break
		}
		t = t.Add(time.Minute)
	}
	w := wall(t)
	return expiryCalendarTime{Month: w[0], Day: w[1], Hour: w[2], Minute: w[3]}
}

func plistEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func renderRecoveryPlist(label string, args []string, schedule string) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>` + label + `</string>

    <key>ProgramArguments</key>
    <array>
`)
	for _, arg := range args {
		b.WriteString("        <string>" + plistEscape(arg) + "</string>\n")
	}
	b.WriteString(`    </array>

    <key>UserName</key>
    <string>root</string>

    <key>GroupName</key>
    <string>wheel</string>

` + schedule + `
    <key>StandardOutPath</key>
    <string>` + recoveryLogPath + `</string>

    <key>StandardErrorPath</key>
    <string>` + recoveryLogPath + `</string>
</dict>
</plist>
`)
	return []byte(b.String())
}

// renderPollPlist: recovery's boot-apply is expiry first, then re-installing a
// still-valid episode's rules, which pf does not keep across a reboot.
func renderPollPlist(recoveryPath, dataDir string) []byte {
	return renderRecoveryPlist(pollLabel, []string{recoveryPath, "boot-apply", "--data-dir", dataDir},
		"    <key>RunAtLoad</key>\n    <true/>\n\n    <key>StartInterval</key>\n    <integer>900</integer>\n")
}

func renderRollbackPlist(recoveryPath, dataDir, attemptID string) []byte {
	return renderRecoveryPlist(rollbackLabel, []string{recoveryPath, "rollback-if-uncommitted", "--data-dir", dataDir, "--attempt", attemptID},
		"    <key>RunAtLoad</key>\n    <false/>\n\n    <key>StartInterval</key>\n    <integer>15</integer>\n")
}

func renderExpirePlist(recoveryPath, dataDir string, at time.Time, loc *time.Location) []byte {
	c := expiryCalendar(at, loc)
	schedule := fmt.Sprintf("    <key>RunAtLoad</key>\n    <false/>\n\n    <key>StartCalendarInterval</key>\n    <dict>\n"+
		"        <key>Month</key>\n        <integer>%d</integer>\n        <key>Day</key>\n        <integer>%d</integer>\n"+
		"        <key>Hour</key>\n        <integer>%d</integer>\n        <key>Minute</key>\n        <integer>%d</integer>\n    </dict>\n",
		c.Month, c.Day, c.Hour, c.Minute)
	return renderRecoveryPlist(expireLabel, []string{recoveryPath, "expire-check", "--data-dir", dataDir}, schedule)
}

func (s *darwinScheduler) plistPath(label string) string {
	return filepath.Join(s.daemonDir, label+".plist")
}

// checkedRecoveryPath is the journal's recovery executable, present and signed.
// A task must never name anything else.
func (s *darwinScheduler) checkedRecoveryPath() (string, error) {
	j, err := journal.Load(journal.Path(s.dataDir))
	if err != nil {
		return "", fmt.Errorf("load recovery path: %w", err)
	}
	path := j.RecoveryPath
	if strings.TrimSpace(path) == "" {
		return "", errors.New("journal has no recovery path")
	}
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("recovery executable does not exist: %s", path)
	}
	if err := s.verifySignature(path); err != nil {
		return "", fmt.Errorf("verify recovery executable: %w", err)
	}
	return path, nil
}

func (s *darwinScheduler) ArmProvisional(attemptID string, _ time.Time) error {
	if !recoveryAttemptPattern.MatchString(attemptID) {
		return fmt.Errorf("invalid isolation rollback attempt ID %q", attemptID)
	}
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	return s.install(rollbackLabel, path, renderRollbackPlist(path, s.dataDir, attemptID))
}

// ArmExpiry overwrites the one expiry job. Recovery re-reads the journal, so a
// stale firing after an extend is a no-op.
func (s *darwinScheduler) ArmExpiry(_ string, _ int, at time.Time) error {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	return s.install(expireLabel, path, renderExpirePlist(path, s.dataDir, at, s.location()))
}

func (s *darwinScheduler) EnsurePoll() error {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	return s.install(pollLabel, path, renderPollPlist(path, s.dataDir))
}

// install writes the plist (root:wheel 0644, atomically) and loads it into the
// system domain, then reads it back. An unchanged job that is already loaded
// is left alone: reloading the poll would fire its RunAtLoad again.
func (s *darwinScheduler) install(label, program string, plist []byte) error {
	path := s.plistPath(label)
	if current, err := os.ReadFile(path); err == nil && bytes.Equal(current, plist) {
		if loaded, err := s.loaded(label); err == nil && loaded {
			return s.readback(label, program, plist)
		}
	}
	if err := s.unload(label); err != nil {
		return err
	}
	if err := s.writePlist(path, plist); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	// A job left disabled in launchd's override database refuses to bootstrap.
	if out, code, err := s.launchctl("enable", "system/"+label); err != nil || code != 0 {
		log.Warn("could not enable the isolation recovery job; loading it anyway", "label", label, "output", strings.TrimSpace(out))
	}
	if out, code, err := s.launchctl("bootstrap", "system", path); err != nil || code != 0 {
		return fmt.Errorf("launchctl bootstrap %s exited %d: %s %v", label, code, strings.TrimSpace(out), err)
	}
	return s.readback(label, program, plist)
}

// readback confirms launchd holds this job, from this plist, running the
// recovery executable, and that the plist on disk is what we wrote.
func (s *darwinScheduler) readback(label, program string, plist []byte) error {
	out, code, err := s.launchctl("print", "system/"+label)
	if err != nil || code != 0 {
		return fmt.Errorf("read back %s: launchctl print exited %d: %v", label, code, err)
	}
	if !strings.Contains(out, s.plistPath(label)) || !strings.Contains(out, program) {
		return fmt.Errorf("read back %s: the loaded job does not run the recovery executable from its plist", label)
	}
	current, err := os.ReadFile(s.plistPath(label))
	if err != nil || !bytes.Equal(current, plist) {
		return fmt.Errorf("read back %s: the plist on disk changed", label)
	}
	return nil
}

func (s *darwinScheduler) writePlist(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	_, writeErr := tmp.Write(data)
	syncErr := tmp.Sync()
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	// launchd ignores a daemon plist that is not root-owned or is writable by
	// anyone else.
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	if err := s.chown(tmp.Name()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func (s *darwinScheduler) loaded(label string) (bool, error) {
	_, code, err := s.launchctl("print", "system/"+label)
	switch {
	case err != nil:
		return false, err
	case code == 0:
		return true, nil
	case code == launchctlNotLoaded:
		return false, nil
	}
	return false, fmt.Errorf("launchctl print system/%s exited %d", label, code)
}

// unload takes the job out of launchd and waits until it is gone. A job cannot
// wait for itself: it asks launchd to remove it without blocking, and launchd
// stops it once this process exits.
func (s *darwinScheduler) unload(label string) error {
	if s.selfLabel() == label {
		if out, code, err := s.launchctl("remove", label); err != nil || code != 0 {
			return fmt.Errorf("launchctl remove %s exited %d: %s %v", label, code, strings.TrimSpace(out), err)
		}
		return nil
	}
	if _, _, err := s.launchctl("bootout", "system/"+label); err != nil {
		return err
	}
	for polls := 0; ; polls++ {
		loaded, err := s.loaded(label)
		if err != nil {
			return err
		}
		if !loaded {
			return nil
		}
		if polls >= bootoutPolls {
			return fmt.Errorf("%s is still loaded after bootout", label)
		}
		s.sleep(bootoutPollStep)
	}
}

// remove unloads one job and deletes its plist. The running job's own plist is
// deleted first, since its unload completes only when this process exits.
func (s *darwinScheduler) remove(label string) error {
	path := s.plistPath(label)
	if s.selfLabel() == label {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return s.unload(label)
	}
	if err := s.unload(label); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// DisarmProvisional removes the rollback job only if it still belongs to this
// attempt: a stale invocation must not unload a newer attempt's rollback.
func (s *darwinScheduler) DisarmProvisional(attemptID string) error {
	if !recoveryAttemptPattern.MatchString(attemptID) {
		return fmt.Errorf("invalid isolation rollback attempt ID %q", attemptID)
	}
	current, err := os.ReadFile(s.plistPath(rollbackLabel))
	if errors.Is(err, fs.ErrNotExist) {
		return s.remove(rollbackLabel)
	}
	if err != nil {
		return err
	}
	if !bytes.Contains(current, []byte("<string>"+attemptID+"</string>")) {
		return nil
	}
	return s.remove(rollbackLabel)
}

// RemoveAll removes every recovery job, the running one last.
func (s *darwinScheduler) RemoveAll() error {
	labels := []string{rollbackLabel, expireLabel, pollLabel}
	if self := s.selfLabel(); slices.Contains(labels, self) {
		labels = append(slices.DeleteFunc(labels, func(l string) bool { return l == self }), self)
	}
	var failures []error
	for _, label := range labels {
		if err := s.remove(label); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// Ready: the journal's recovery executable is present and signed, the poll job
// is loaded from it, and the executable passes its self-test.
func (s *darwinScheduler) Ready() (bool, string) {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return false, err.Error()
	}
	if err := s.readback(pollLabel, path, renderPollPlist(path, s.dataDir)); err != nil {
		return false, err.Error()
	}
	if err := s.selfTest(path); err != nil {
		return false, fmt.Sprintf("recovery self-test: %v", err)
	}
	return true, ""
}
