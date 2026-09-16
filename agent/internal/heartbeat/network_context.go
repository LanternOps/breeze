package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"github.com/breeze-rmm/agent/internal/config"
)

type networkContextConfig struct {
	AcceptedVersions        []int  `json:"acceptedNetworkContextVersions"`
	ProducerEpoch           string `json:"producerEpoch"`
	SourceIdentity          string `json:"sourceIdentity"`
	ConfigurationRevision   string `json:"configurationRevision"`
	ExpectedIntervalSeconds int    `json:"expectedIntervalSeconds"`
	EpochFreshlyIssued      bool   `json:"epochFreshlyIssued"`
}
type NetworkContextReset struct {
	PreviousEpoch string `json:"previousEpoch"`
}
type networkContextManager struct {
	latestSnapshot  *networkcontext.Snapshot
	eventsAvailable bool
	startOnce       sync.Once
	mu              sync.Mutex
	state           *networkcontext.State
	scheduler       *networkcontext.Scheduler
	config          networkContextConfig
	reader          networkcontext.Reader
	pendingReset    string
	enabled         bool
	captured        time.Time
	cancel          context.CancelFunc
}

func newNetworkContextManager(path string) (*networkContextManager, error) {
	state, err := networkcontext.OpenState(path)
	if err != nil && !errors.Is(err, networkcontext.ErrEpochRequired) && !errors.Is(err, networkcontext.ErrMalformed) {
		return nil, err
	}
	return &networkContextManager{state: state, scheduler: networkcontext.NewScheduler(rand.Float64)}, nil
}
func (c networkContextConfig) accepts() bool {
	for _, version := range c.AcceptedVersions {
		if version == 1 {
			return true
		}
	}
	return false
}
func (m *networkContextManager) configure(c networkContextConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !c.accepts() {
		m.enabled = false
		if m.cancel != nil {
			m.cancel()
		}
		return nil
	}
	if c.ProducerEpoch == "" || c.SourceIdentity == "" || c.ExpectedIntervalSeconds != 300 {
		return networkcontext.ErrMalformed
	}
	current := m.state.Snapshot()
	if current.ProducerEpoch == "" && !c.EpochFreshlyIssued {
		if m.pendingReset == "" || m.pendingReset == c.ProducerEpoch {
			m.pendingReset = c.ProducerEpoch
			m.config = c
			m.enabled = false
			return nil
		}
	}
	if current.ProducerEpoch != c.ProducerEpoch || current.SourceIdentity != c.SourceIdentity {
		if m.cancel != nil {
			m.cancel()
		}
		if err := m.state.InstallEpoch(c.SourceIdentity, c.ProducerEpoch); err != nil {
			return err
		}
		m.reader = networkcontext.NewReader(c.ProducerEpoch)
		if identities, ok := m.reader.(interface {
			SetIdentityResolver(func(string) (string, error))
		}); ok {
			identities.SetIdentityResolver(m.state.ResolveInterfaceIdentity)
		}
		m.scheduler = networkcontext.NewScheduler(rand.Float64)
		m.captured = time.Time{}
		m.latestSnapshot = nil
	}
	if m.reader == nil {
		m.reader = networkcontext.NewReader(c.ProducerEpoch)
		if identities, ok := m.reader.(interface {
			SetIdentityResolver(func(string) (string, error))
		}); ok {
			identities.SetIdentityResolver(m.state.ResolveInterfaceIdentity)
		}
	}
	m.pendingReset = ""
	m.config = c
	m.enabled = true
	return nil
}
func (m *networkContextManager) attach(now time.Time, stop <-chan struct{}) (*networkcontext.Report, *NetworkContextReset) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pendingReset != "" {
		return nil, &NetworkContextReset{PreviousEpoch: m.pendingReset}
	}
	if !m.enabled {
		return nil, nil
	}
	state := m.state.Snapshot()
	// Retry one immutable capture until acknowledged; retries preserve sequence
	// and never become an unchanged confirmation of a new collection.
	if state.Pending != nil {
		report := state.Pending
		if !m.captured.IsZero() {
			age := now.Sub(m.captured).Milliseconds()
			if age >= 0 {
				report.CaptureAgeAtSendMS = &age
			}
		}
		return report, nil
	}
	if m.scheduler.Begin(now) {
		ctx, cancel := context.WithCancel(context.Background())
		m.cancel = cancel
		reader := m.reader
		scheduler := m.scheduler
		epoch := m.config.ProducerEpoch
		go func() {
			defer cancel()
			defer scheduler.Finish()
			done := make(chan struct{})
			defer close(done)
			go func() {
				select {
				case <-stop:
					cancel()
				case <-done:
				}
			}()
			sequence, err := m.state.AllocateSequence()
			if err != nil {
				log.Warn("network context sequence allocation failed", "error", err)
				return
			}
			captureStarted := time.Now()
			snapshot, readErr := networkcontext.Collect(ctx, reader)
			m.mu.Lock()
			eventsAvailable := m.eventsAvailable
			m.mu.Unlock()
			snapshot.Capabilities = append(snapshot.Capabilities, networkcontext.Capability{Name: "change_notifications", Version: 1, Supported: eventsAvailable}, networkcontext.Capability{Name: "network_diagnostic", Version: 1, Supported: true})
			if readErr != nil {
				log.Warn("network context collection incomplete", "error", readErr)
			}
			state := m.state.Snapshot()
			if state.ProducerEpoch != epoch || state.Sequence != sequence {
				return
			}
			report, err := networkcontext.BuildReport(snapshot, state)
			if err != nil {
				log.Warn("network context report rejected locally", "error", err)
				return
			}
			m.mu.Lock()
			defer m.mu.Unlock()
			if !m.enabled || m.config.ProducerEpoch != epoch {
				return
			}
			if err = m.state.StoreReport(report); err != nil {
				log.Warn("network context capture persistence failed", "error", err)
				return
			}
			m.captured = captureStarted
			m.latestSnapshot = &snapshot
		}()
	}
	return nil, nil
}
func (m *networkContextManager) ack(receipt networkcontext.Receipt) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state.AcceptReport(receipt)
}
func (h *Heartbeat) applyNetworkContextConfig(raw any) {
	b, err := json.Marshal(raw)
	if err != nil {
		return
	}
	var c networkContextConfig
	if err = json.Unmarshal(b, &c); err != nil {
		log.Warn("invalid network context configuration")
		return
	}
	h.networkContextMu.Lock()
	defer h.networkContextMu.Unlock()
	if h.networkContext == nil {
		h.networkContext, err = newNetworkContextManager(filepath.Join(config.GetDataDir(), "topology-context-state.json"))
		if err != nil {
			log.Warn("network context state unavailable", "error", err)
			return
		}
	}
	h.networkContext.start(h.stopChan)
	if err = h.networkContext.configure(c); err != nil {
		log.Warn("network context configuration unavailable", "error", err)
	}
}
func (h *Heartbeat) attachNetworkContext(payload *HeartbeatPayload) {
	h.networkContextMu.Lock()
	manager := h.networkContext
	h.networkContextMu.Unlock()
	if manager != nil {
		payload.NetworkContextV1, payload.NetworkContextReset = manager.attach(time.Now(), h.stopChan)
	}
}
func (h *Heartbeat) ackNetworkContext(receipt *networkcontext.Receipt) {
	if receipt == nil {
		return
	}
	h.networkContextMu.Lock()
	manager := h.networkContext
	h.networkContextMu.Unlock()
	if manager != nil {
		if err := manager.ack(*receipt); err != nil {
			log.Warn("network context receipt not accepted", "error", err)
		}
	}
}

func (m *networkContextManager) start(stop <-chan struct{}) {
	m.startOnce.Do(func() {
		watchCtx, watchCancel := context.WithCancel(context.Background())
		m.mu.Lock()
		m.eventsAvailable = true
		m.mu.Unlock()
		go func() {
			if err := networkcontext.WatchChanges(watchCtx, func() { m.mu.Lock(); scheduler := m.scheduler; m.mu.Unlock(); scheduler.Notify(time.Now()) }); err != nil && !errors.Is(err, context.Canceled) {
				log.Warn("network context event listener unavailable; periodic reads continue", "error", err)
				m.mu.Lock()
				m.eventsAvailable = false
				m.mu.Unlock()
			}
		}()

		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case now := <-ticker.C:
					m.attach(now, stop)
				case <-stop:
					watchCancel()
					m.mu.Lock()
					if m.cancel != nil {
						m.cancel()
					}
					m.mu.Unlock()
					return
				}
			}
		}()
	})
}
