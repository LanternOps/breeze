// Package flashguard is the durable critical section around a BIOS or firmware
// install. Nothing may interrupt a flash: a reboot, a shutdown or an agent
// replacement mid-write can leave a machine that does not boot.
//
// A flash calls Enter. Every path that can take the machine or the agent down
// calls AdmitPowerAction and holds its admission through the OS invocation. The
// two conflict on one lock, so a flash cannot start between a power action's
// check and its `shutdown`, and a power action cannot start during a flash.
//
// The state is on disk because the watchdog is a separate process and a section
// has to survive an agent restart. The lock is an OS file lock for the same
// reason: it spans processes and the kernel releases it if the holder dies.
// Every section ends by itself after at most MaxTTL, so a crash cannot block
// reboots forever.
//
// With no section open this package changes nothing about a power action except
// a file lock around it, and a failure to take that lock does not stop one.
package flashguard

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/securefs"
)

var log = logging.L("flashguard")

const (
	// MaxTTL is the longest a section can last, however it was requested and
	// whatever the file says.
	MaxTTL = 3 * time.Hour

	// CountdownSlack is added to a noted OS countdown. The machine does not
	// stop at the instant the countdown ends, and a flash must not start in
	// the gap.
	CountdownSlack = 5 * time.Minute

	// maxNotedCountdown is the longest a noted countdown can plausibly run: the
	// 24-hour ceiling on a shutdown delay, plus the slack. Anything further out
	// came from a clock that moved, and is ignored.
	maxNotedCountdown = 24*time.Hour + CountdownSlack

	// clockSkewAllowance is how far ahead of now a section's start can be and
	// still be honoured. Past it the clock was wound back, and the section
	// would otherwise hold reboots for as long as it was wound.
	clockSkewAllowance = 10 * time.Minute

	sectionFile   = "section.json"
	countdownFile = "countdown.json"
	lockFile      = "guard.lock"

	maxStateFileBytes = 4096

	defaultLockWait     = 5 * time.Second
	defaultWaitPoll     = 5 * time.Second
	enterLockWait       = 250 * time.Millisecond
	lockRetryInterval   = 5 * time.Millisecond
	defaultGuardDirName = "flashguard"
)

var (
	// ErrPowerActionPending is returned by Enter when an OS shutdown countdown
	// is armed or a power action is executing. The flash has not started.
	ErrPowerActionPending = errors.New("a power action is pending")
	// ErrFlashInProgress is returned to a power action during a section.
	ErrFlashInProgress = errors.New("a firmware update is in progress")
	// ErrSectionActive is returned by Enter when another section is open.
	ErrSectionActive = errors.New("another firmware update section is active")
)

// Section describes one open critical section.
type Section struct {
	Kind      string    `json:"kind"`
	CommandID string    `json:"commandId"`
	StartedAt time.Time `json:"startedAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Guard is one view of the on-disk state. All of its answers come from the
// state directory, so two Guards on the same directory agree.
type Guard struct {
	dir      string
	now      func() time.Time
	lockWait time.Duration
	waitPoll time.Duration
	waitMax  time.Duration

	probeMu sync.Mutex
	probe   func() bool
}

// Option adjusts a Guard built by New.
type Option func(*Guard)

// WithClock replaces the wall clock.
func WithClock(now func() time.Time) Option { return func(g *Guard) { g.now = now } }

// WithLockWait bounds how long an admission waits out a momentary exclusive
// holder of the lock.
func WithLockWait(d time.Duration) Option { return func(g *Guard) { g.lockWait = d } }

// WithWaitTiming sets how often WaitForPowerAction re-checks and when it gives up.
func WithWaitTiming(poll, ceiling time.Duration) Option {
	return func(g *Guard) { g.waitPoll, g.waitMax = poll, ceiling }
}

// New returns a Guard keeping its state in dir, which must be absolute.
func New(dir string, opts ...Option) *Guard {
	g := &Guard{
		dir:      dir,
		now:      time.Now,
		lockWait: defaultLockWait,
		waitPoll: defaultWaitPoll,
		waitMax:  MaxTTL,
	}
	for _, opt := range opts {
		opt(g)
	}
	return g
}

var (
	defaultOnce  sync.Once
	defaultGuard *Guard
	override     atomic.Pointer[Guard]
)

// Default returns the process-wide Guard, with its state under the agent's data
// directory. The directory is resolved on first use, so a process that never
// reaches a power path never touches it.
func Default() *Guard {
	if g := override.Load(); g != nil {
		return g
	}
	defaultOnce.Do(func() {
		defaultGuard = New(filepath.Join(config.GetDataDir(), defaultGuardDirName))
	})
	return defaultGuard
}

// SetDefault makes g the process-wide Guard until the returned function runs.
// It exists so a test of a wired path never touches the real data directory.
func SetDefault(g *Guard) (restore func()) {
	previous := override.Swap(g)
	return func() { override.Store(previous) }
}

// SetCountdownProbe registers a check for an OS shutdown countdown that only its
// owner can see. Enter refuses while it returns true. It runs with the guard's
// exclusive lock held, so it must not call back into the Guard.
func (g *Guard) SetCountdownProbe(probe func() bool) {
	g.probeMu.Lock()
	defer g.probeMu.Unlock()
	g.probe = probe
}

func (g *Guard) countdownArmed() bool {
	g.probeMu.Lock()
	probe := g.probe
	g.probeMu.Unlock()
	if probe != nil && probe() {
		return true
	}
	var noted notedCountdown
	if err := g.readJSON(countdownFile, &noted); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Warn("could not read the noted shutdown countdown", "error", err.Error())
		}
		return false
	}
	now := g.now()
	return now.Before(noted.Until) && noted.Until.Sub(now) <= maxNotedCountdown
}

// Enter opens a section lasting ttl, capped at MaxTTL. It fails closed: if the
// section cannot be recorded it returns an error and the flash must not start.
//
// release ends the section. It is safe to call more than once, and it does not
// disturb a newer section if this one has already expired.
func (g *Guard) Enter(kind, commandID string, ttl time.Duration) (release func() error, err error) {
	if kind == "" || commandID == "" {
		return nil, errors.New("flashguard: a section needs a kind and a command id")
	}
	if ttl <= 0 {
		return nil, errors.New("flashguard: a section needs a positive ttl")
	}
	if ttl > MaxTTL {
		ttl = MaxTTL
	}
	lock, err := g.acquire(lockExclusive, enterLockWait)
	if err != nil {
		if errors.Is(err, errLockBusy) {
			return nil, ErrPowerActionPending
		}
		return nil, fmt.Errorf("flashguard: take lock: %w", err)
	}
	defer lock.release()

	if s, state := g.readSection(); state == sectionActive {
		return nil, fmt.Errorf("%w: %s", ErrSectionActive, s.describe())
	}
	if g.countdownArmed() {
		return nil, ErrPowerActionPending
	}
	now := g.now()
	section := Section{Kind: kind, CommandID: commandID, StartedAt: now, ExpiresAt: now.Add(ttl)}
	if err := g.writeJSON(sectionFile, section); err != nil {
		return nil, fmt.Errorf("flashguard: record section: %w", err)
	}
	log.Info("firmware update section entered", "kind", kind, "commandId", commandID, "expiresAt", section.ExpiresAt)

	var once sync.Once
	var releaseErr error
	return func() error {
		once.Do(func() { releaseErr = g.release(section) })
		return releaseErr
	}, nil
}

// release removes section unless the file now holds a different one. A failure
// leaves the file for expiry to clear, which only delays reboots by at most the
// section's remaining TTL.
func (g *Guard) release(section Section) error {
	lock, err := g.acquire(lockExclusive, g.lockWait)
	if err != nil {
		return fmt.Errorf("flashguard: take lock to release: %w", err)
	}
	defer lock.release()
	var current Section
	if err := g.readJSON(sectionFile, &current); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("flashguard: read section to release: %w", err)
	}
	if !current.sameAs(section) {
		return nil
	}
	if err := g.removeState(sectionFile); err != nil {
		return fmt.Errorf("flashguard: remove section: %w", err)
	}
	log.Info("firmware update section released", "kind", section.Kind, "commandId", section.CommandID)
	return nil
}

// Active reports the open section. A section past its expiry counts as inactive
// and is cleared.
func (g *Guard) Active() (Section, bool) {
	s, state := g.readSection()
	switch state {
	case sectionActive:
		return s, true
	case sectionExpired:
		g.clearExpired()
	}
	return Section{}, false
}

// clearExpired removes an expired section under the exclusive lock and after a
// re-read, so it can never remove a section entered since the first read. The
// file is only tidied here: expiry already made it inactive, so a busy lock
// simply leaves it for a later call.
func (g *Guard) clearExpired() {
	lock, err := g.acquire(lockExclusive, 0)
	if err != nil {
		return
	}
	defer lock.release()
	s, state := g.readSection()
	if state != sectionExpired {
		return
	}
	if err := g.removeState(sectionFile); err != nil {
		log.Warn("could not clear an expired firmware update section", "error", err.Error())
		return
	}
	log.Warn("cleared an expired firmware update section; the install overran or the agent stopped during it",
		"kind", s.Kind, "commandId", s.CommandID)
}

// AdmitPowerAction asks to take the machine or the agent down. On success the
// caller holds its admission until it calls done, which it must do only after
// the OS invocation returns; Enter is refused for that whole time. done is safe
// to call more than once, and a process that exits never has to call it.
//
// During a section it returns ErrFlashInProgress and a nil done.
//
// If the lock cannot be taken at all, the action proceeds. Enter fails closed on
// the same error, so this process cannot have opened a section, and an agent with
// a broken data directory keeps the reboots it had before this guard.
func (g *Guard) AdmitPowerAction(name string) (done func(), err error) {
	lock, err := g.acquire(lockShared, g.lockWait)
	switch {
	case errors.Is(err, errLockBusy):
		// Exclusive holders stay only for a file write, so this much contention
		// means something is wrong. Holding is the safe answer, and every caller
		// retries or reports it.
		return nil, fmt.Errorf("%w: guard lock busy", ErrFlashInProgress)
	case err != nil:
		log.Warn("flash guard lock unavailable; proceeding", "action", name, "error", err.Error())
		lock = nil
	}
	if s, state := g.readSection(); state == sectionActive {
		lock.release()
		return nil, fmt.Errorf("%w: %s", ErrFlashInProgress, s.describe())
	}
	var once sync.Once
	return func() { once.Do(lock.release) }, nil
}

// WaitForPowerAction is AdmitPowerAction for a caller that must wait out a
// section rather than be refused. It gives up after MaxTTL, which is longer than
// any one section lasts, and running out returns ErrFlashInProgress: it never
// means acting during a flash.
func (g *Guard) WaitForPowerAction(name string) (done func(), err error) {
	deadline := g.now().Add(g.waitMax)
	logged := false
	for {
		done, err := g.AdmitPowerAction(name)
		if !errors.Is(err, ErrFlashInProgress) {
			return done, err
		}
		if !logged {
			log.Info("power action waiting for a firmware update to finish", "action", name, "reason", err.Error())
			logged = true
		}
		if !g.now().Before(deadline) {
			return nil, err
		}
		time.Sleep(g.waitPoll)
	}
}

// NoteCountdown records that an OS shutdown countdown of length delay has just
// been armed, so Enter refuses until it has run out, in this process or the next.
// A shorter note never replaces a longer one. Failing to record it is logged and
// otherwise ignored: the reboot has already been issued.
func (g *Guard) NoteCountdown(delay time.Duration) {
	until := g.now().Add(delay + CountdownSlack)
	var existing notedCountdown
	if err := g.readJSON(countdownFile, &existing); err == nil && existing.Until.After(until) {
		return
	}
	if err := g.writeJSON(countdownFile, notedCountdown{Until: until}); err != nil {
		log.Warn("could not record the shutdown countdown", "error", err.Error())
	}
}

type notedCountdown struct {
	Until time.Time `json:"until"`
}

type sectionState int

const (
	sectionNone sectionState = iota
	sectionActive
	sectionExpired
)

// readSection reads and classifies the section file.
//
// A file that exists but cannot be parsed holds, for MaxTTL from when it was
// written. The atomic write cannot tear, so nothing normal produces one, and it
// may be a live flash. A file that cannot be read at all does not hold: that
// error would repeat for ever, and only MaxTTL is allowed to block a reboot.
func (g *Guard) readSection() (Section, sectionState) {
	var s Section
	err := g.readJSON(sectionFile, &s)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return Section{}, sectionNone
	case errors.Is(err, errCorruptState):
		return g.classifyCorrupt()
	default:
		log.Warn("could not read the firmware update section", "error", err.Error())
		return Section{}, sectionNone
	}
	now := g.now()
	expires := s.ExpiresAt
	if ceiling := s.StartedAt.Add(MaxTTL); expires.After(ceiling) {
		expires = ceiling
	}
	if !now.Before(expires) || s.StartedAt.After(now.Add(clockSkewAllowance)) {
		return s, sectionExpired
	}
	s.ExpiresAt = expires
	return s, sectionActive
}

func (g *Guard) classifyCorrupt() (Section, sectionState) {
	info, err := securefs.StatFile(g.dir, sectionFile)
	if err != nil {
		log.Warn("could not inspect a corrupt firmware update section", "error", err.Error())
		return Section{}, sectionNone
	}
	written := info.ModTime()
	s := Section{Kind: "unknown", CommandID: "unknown", StartedAt: written, ExpiresAt: written.Add(MaxTTL)}
	if g.now().Before(s.ExpiresAt) {
		log.Warn("firmware update section is unreadable; holding power actions until it ages out", "expiresAt", s.ExpiresAt)
		return s, sectionActive
	}
	return s, sectionExpired
}

func (s Section) describe() string {
	return fmt.Sprintf("%s for command %s until %s", s.Kind, s.CommandID, s.ExpiresAt.UTC().Format(time.RFC3339))
}

func (s Section) sameAs(other Section) bool {
	return s.Kind == other.Kind && s.CommandID == other.CommandID && s.StartedAt.Equal(other.StartedAt)
}

var errCorruptState = errors.New("flashguard state file is corrupt")

func (g *Guard) readJSON(name string, into any) error {
	f, err := securefs.OpenFile(g.dir, name)
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxStateFileBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxStateFileBytes {
		return fmt.Errorf("%w: larger than %d bytes", errCorruptState, maxStateFileBytes)
	}
	if err := json.Unmarshal(data, into); err != nil {
		return fmt.Errorf("%w: %v", errCorruptState, err)
	}
	return nil
}

// writeJSON publishes the file atomically. The temp file is synced first so the
// state is on disk before the flash it guards begins.
func (g *Guard) writeJSON(name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := securefs.EnsurePrivateDir(g.dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(g.dir, "."+name+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	_, err = securefs.InstallFile(g.dir, name, tmpPath, 0o600, g.now(), nil)
	return err
}

func (g *Guard) removeState(name string) error {
	err := os.Remove(filepath.Join(g.dir, name))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

var errLockBusy = errors.New("flashguard lock is busy")

type lockMode int

const (
	lockShared lockMode = iota
	lockExclusive
)

// heldLock is one open handle holding the guard's file lock. Closing the handle
// releases it. A nil heldLock is a no-op, which is the fail-open admission.
type heldLock struct {
	file *os.File
}

func (l *heldLock) release() {
	if l == nil || l.file == nil {
		return
	}
	_ = l.file.Close()
}

// acquire takes the lock on a fresh handle, so holders inside one process
// conflict exactly as holders in two processes do. It never blocks in the OS: it
// retries until wait has passed and then returns errLockBusy, so a wedged holder
// can delay a caller but never hang it.
func (g *Guard) acquire(mode lockMode, wait time.Duration) (*heldLock, error) {
	if err := securefs.EnsurePrivateDir(g.dir); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(g.dir, lockFile), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		err := tryLock(f, mode)
		if err == nil {
			return &heldLock{file: f}, nil
		}
		if !errors.Is(err, errLockBusy) || !time.Now().Before(deadline) {
			_ = f.Close()
			return nil, err
		}
		time.Sleep(lockRetryInterval)
	}
}
