package wakeconfig

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/observability"
)

// ErrUnsupported means this OS has no wake readiness collector. The manager
// collects and uploads nothing; the server derives unsupported_os.
var ErrUnsupported = errors.New("wake readiness collection is not supported on this OS")

// DefaultInterval is both the re-collection period and the upload keepalive.
const DefaultInterval = 24 * time.Hour

// DefaultRetryInterval is the wait after a failed collection or upload.
const DefaultRetryInterval = time.Hour

// Settings is what the heartbeat's wake_on_lan_settings block carries.
type Settings struct {
	Enabled bool
	// ConfigureSettings is the delivered configure_settings. It reaches a
	// Writer only once writesActivated is true.
	ConfigureSettings bool
}

// policyFingerprint identifies the delivered policy for the write limiter: a
// change resets the per-setting failure history.
func policyFingerprint(s Settings) string {
	return fmt.Sprintf("v1|enabled=%t|configure=%t", s.Enabled, s.ConfigureSettings)
}

// Options configures a Manager.
type Options struct {
	// Collect returns the live readings (Memory and Now are filled in here).
	Collect func(ctx context.Context) (Inputs, error)
	// Upload sends the snapshot; a nil return means the server accepted it.
	Upload    func(ctx context.Context, s Snapshot) error
	Now       func() time.Time
	StatePath string
	// Interval defaults to 24 h.
	Interval time.Duration
	// RetryInterval follows a failed collection or upload; defaults to 1 h.
	RetryInterval time.Duration
	// FirstDelay holds the first cycle off the boot path (the heartbeat passes a
	// jittered 60-120 s). Settings that arrive earlier are coalesced into it.
	FirstDelay time.Duration

	// Writer applies Windows and NIC settings; nil means never write.
	Writer Writer
	// Reread re-reads the Windows layer after writes.
	Reread func(ctx context.Context) (*WindowsReadings, error)
	// BootID clears needs_reboot once the machine has booted since a write.
	BootID func() (string, error)

	// testAllowWrites stands in for writesActivated in this package's tests.
	// It is unexported so no other package can enable writes.
	testAllowWrites bool
}

// Manager runs the collect-and-maybe-upload loop while the policy enables it.
type Manager struct {
	opts Options

	mu       sync.Mutex
	settings Settings
	dirty    bool // settings changed since the loop last looked
	// lastFP is the policy fingerprint last delivered in this process; fpChanged
	// records that it moved, even if it moved back before a cycle ran.
	lastFP    string
	haveFP    bool
	fpChanged bool
	started   bool
	cancel    context.CancelFunc
	done      chan struct{}

	sig chan struct{} // buffered(1): settings changed
}

// New builds a Manager; call Start to run it.
func New(opts Options) *Manager {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Interval <= 0 {
		opts.Interval = DefaultInterval
	}
	if opts.RetryInterval <= 0 {
		opts.RetryInterval = DefaultRetryInterval
	}
	return &Manager{opts: opts, sig: make(chan struct{}, 1), done: make(chan struct{})}
}

// ApplySettings stores the settings and signals the loop. It never blocks.
func (m *Manager) ApplySettings(s Settings) {
	m.mu.Lock()
	if s != m.settings {
		m.dirty = true
	}
	m.settings = s
	fp := policyFingerprint(s)
	if m.haveFP && fp != m.lastFP {
		m.fpChanged = true
	}
	m.lastFP, m.haveFP = fp, true
	m.mu.Unlock()
	select {
	case m.sig <- struct{}{}:
	default:
	}
}

func (m *Manager) enabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settings.Enabled
}

func (m *Manager) currentSettings() Settings {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settings
}

func (m *Manager) takeDirty() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.dirty
	m.dirty = false
	return d
}

func (m *Manager) takeFPChanged() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.fpChanged
	m.fpChanged = false
	return c
}

// writesAllowed is the single gate in front of every Writer call.
func (m *Manager) writesAllowed(s Settings) bool {
	return s.Enabled && s.ConfigureSettings && (writesActivated || m.opts.testAllowWrites) && m.opts.Writer != nil
}

// Start launches the loop. It returns immediately and is idempotent.
func (m *Manager) Start(parent context.Context) {
	m.mu.Lock()
	if m.started {
		m.mu.Unlock()
		return
	}
	m.started = true
	ctx, cancel := context.WithCancel(parent)
	m.cancel = cancel
	m.mu.Unlock()
	go func() {
		defer close(m.done)
		defer observability.Recoverer("wakeconfig.manager")
		m.run(ctx)
	}()
}

// Stop cancels any in-flight collection or upload. It does not wait; use Done.
func (m *Manager) Stop() {
	m.mu.Lock()
	cancel := m.cancel
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Done is closed once the loop has exited.
func (m *Manager) Done() <-chan struct{} { return m.done }

func (m *Manager) run(ctx context.Context) {
	if d := m.opts.FirstDelay; d > 0 {
		t := time.NewTimer(d)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()
	wasEnabled := false
	armed := false
	for {
		collect := false
		select {
		case <-ctx.Done():
			return
		case <-m.sig:
			en := m.enabled()
			dirty := m.takeDirty()
			if en && (!wasEnabled || dirty) {
				collect = true // enable transition (includes boot) or a settings change
			}
			if !en && armed {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				armed = false
			}
			wasEnabled = en
		case <-timer.C:
			armed = false
			collect = m.enabled()
		}
		if collect && ctx.Err() == nil {
			ok := m.cycle(ctx)
			if m.enabled() && ctx.Err() == nil {
				next := m.opts.Interval
				if !ok && m.opts.RetryInterval < next {
					next = m.opts.RetryInterval
				}
				if armed && !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(next)
				armed = true
			}
		}
	}
}

// cycle collects once and uploads when the fingerprint changed or the last
// accepted upload is 24 h old. State advances only after a successful upload.
// It reports false when collection or upload failed, so the loop retries sooner.
func (m *Manager) cycle(ctx context.Context) bool {
	in, err := m.opts.Collect(ctx)
	if err != nil {
		if errors.Is(err, ErrUnsupported) {
			log.Debug("wake readiness collection unsupported on this OS")
		} else if ctx.Err() == nil {
			log.Warn("wake readiness collection failed; retrying later", "error", err.Error())
		}
		// Unsupported OS is final: wait the full interval, never spin.
		return errors.Is(err, ErrUnsupported)
	}
	now := m.opts.Now()
	st, err := loadStateAt(m.opts.StatePath, now)
	if err != nil {
		// Transient (a sharing violation, a permission glitch): skip the cycle
		// rather than overwrite the good state with an empty one.
		log.Warn("wake status state unreadable; skipping this cycle", "error", err.Error())
		return false
	}
	settings := m.currentSettings()
	if m.takeFPChanged() {
		// The policy moved (perhaps and back) since the last cycle.
		st.Apply.Limiter.resetFailures()
	}
	if in.Windows != nil {
		rep := Apply(ctx, ApplyInputs{
			Configure:         m.writesAllowed(settings),
			PolicyFingerprint: policyFingerprint(settings),
			Virtual:           in.Virtual,
			Readings:          in.Windows,
			Memory:            st.Adapters,
			Reread:            m.opts.Reread,
			Writer:            m.opts.Writer,
			State:             &st.Apply,
			Persist:           func(ApplyState) error { return saveState(m.opts.StatePath, st) },
			StillAllowed:      func() bool { return m.writesAllowed(m.currentSettings()) },
			BootID:            m.opts.BootID,
			Now:               now,
			activated:         writesActivated || m.opts.testAllowWrites,
		})
		in.Windows = rep.Readings
		status := rep.Status
		in.Apply = &status
	}
	in.Memory, in.Now = st.Adapters, now
	snap := Compute(in)
	st.Adapters = snap.Memory
	if err := saveState(m.opts.StatePath, st); err != nil {
		log.Warn("wake status state not saved", "error", err.Error())
	}
	if snap.Fingerprint == st.LastUploadFingerprint && now.Sub(st.LastUploadAt) < m.opts.Interval {
		return true
	}
	if err := m.opts.Upload(ctx, snap); err != nil {
		if ctx.Err() == nil {
			log.Warn("wake status upload failed; retrying later", "error", err.Error())
		}
		return false
	}
	st.LastUploadAt, st.LastUploadFingerprint = now, snap.Fingerprint
	if err := saveState(m.opts.StatePath, st); err != nil {
		log.Warn("wake status state not saved", "error", err.Error())
	}
	return true
}
