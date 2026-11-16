package wakeconfig

import (
	"context"
	"errors"
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
}

// Manager runs the collect-and-maybe-upload loop while the policy enables it.
type Manager struct {
	opts Options

	mu       sync.Mutex
	settings Settings
	started  bool
	cancel   context.CancelFunc
	done     chan struct{}

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
	m.settings = s
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
			if en && !wasEnabled {
				collect = true // enable transition (includes boot)
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
	st := loadState(m.opts.StatePath)
	now := m.opts.Now()
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
