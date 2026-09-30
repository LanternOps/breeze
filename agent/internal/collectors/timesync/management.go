package timesync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"reflect"
	"time"
)

type managementCollector interface {
	Collect(context.Context) (*Snapshot, error)
	Commit(*Snapshot) error
}

type Manager struct {
	gate      chan struct{}
	collector managementCollector
	sys       System
	observe   ReadObservation
	writer    Writer
	// Nil means qualified 2xx acceptance, never merely a successful HTTP exchange.
	send     func(context.Context, any) error
	now      func() time.Time
	save     func(ManagementState) error
	state    ManagementState
	skipOnce bool
	blocked  error
	// blockedFingerprint names the settings whose persistence last failed, so a
	// heartbeat that re-sends them retries the save without re-reporting the error.
	blockedFingerprint string
	// lastRejected identifies the most recent invalid delivery by payload alone.
	// The API re-sends settings on every heartbeat; a repeat is not a new rejection.
	lastRejected string
}

func NewManagement(dir string, sys System, w Writer, send func(context.Context, any) error) (*Manager, error) {
	return newManagement(dir, New(dir, sys), sys, w, send)
}
func newManagement(dir string, c managementCollector, sys System, w Writer, send func(context.Context, any) error) (*Manager, error) {
	path := filepath.Join(dir, managementFile)
	s, e := loadManagement(path)
	m := &Manager{gate: make(chan struct{}, 1), collector: c, sys: sys, writer: w, send: send, now: time.Now, state: s,
		save: func(s ManagementState) error { return saveManagement(path, s) }}
	m.observe = func(ctx context.Context) (Observation, error) { return readManagementObservation(ctx, m.sys, m.now()) }
	return m, e
}

// Read through System on every call. These reads neither allocate a sequence nor
// move the collector's event cursor. Reuse W01b's fail-closed policy/role semantics.
func readManagementObservation(ctx context.Context, sys System, now time.Time) (Observation, error) {
	var o Observation
	if e := ctx.Err(); e != nil {
		return o, e
	}
	if sys == nil {
		return o, fmt.Errorf("time management reads unavailable")
	}
	config := readConfig(ctx, sys)
	o.Config.Type = config.Type
	o.Config.NTPServer = config.NtpServer
	if config.SpecialPollIntervalSeconds != nil {
		o.Config.SpecialPollIntervalSeconds = managementPtr(int(*config.SpecialPollIntervalSeconds))
	}
	o.Config.PolicyManaged = config.PolicyManaged
	o.Config.ServiceState = config.ServiceState
	o.Config.ServiceStartType = config.ServiceStartType
	o.Domain.Role = readDomain(ctx, sys).Role
	if zone, e := sys.DynamicTimezone(ctx); e == nil {
		o.Timezone.WindowsID = zone.WindowsID
	}
	o.Timezone.AutoUpdate = readTimezoneAutoUpdate(ctx, sys)
	// Status fallback reads are observational too: no collector window/cursor access.
	events, _ := sys.RecentEvents(ctx, now.UTC(), 20)
	status := readStatus(ctx, sys, events)
	if status.LastSuccessfulSyncAt != nil {
		o.Status.LastSuccessfulSyncAt = managementPtr(status.LastSuccessfulSyncAt.UTC().Format(time.RFC3339Nano))
	}
	return o, ctx.Err()
}
func (m *Manager) lock(ctx context.Context) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	select {
	case m.gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (m *Manager) unlock() { <-m.gate }
func (m *Manager) Apply(raw any) (bool, error) {
	_ = m.lock(context.Background())
	defer m.unlock()
	s, e := ParseSettings(raw)
	if e == nil && m.state.Settings != nil && m.state.Settings.Fingerprint == s.Fingerprint && !reflect.DeepEqual(*m.state.Settings, s) {
		e = fmt.Errorf("settings changed without a new fingerprint")
	}
	if e != nil {
		key := rejectionKey(raw)
		if key == m.lastRejected {
			// Already reported under one result ID; the retained last-valid settings
			// keep reconciling on the normal schedule.
			return false, nil
		}
		next := m.state
		next.Report.NTP = newResult(s, m.now(), "skipped", "invalid_settings", ntpValues(Observation{}), ntpValues(Observation{}), e)
		if s.Timezone.AutoFix {
			next.Report.Timezone = newResult(s, m.now(), "skipped", "invalid_settings", zoneValues(Observation{}), zoneValues(Observation{}), e)
		}
		// Keep last valid settings, but upload this rejection before reconciling them again.
		m.state = next
		m.skipOnce = true
		m.lastRejected = key
		return true, errors.Join(e, m.save(next))
	}
	m.lastRejected = ""
	if m.state.Settings != nil && reflect.DeepEqual(*m.state.Settings, s) && m.blocked == nil {
		return false, nil
	}
	next := m.state
	next.Settings = &s
	if e = m.save(next); e != nil {
		repeat := m.blocked != nil && m.blockedFingerprint == s.Fingerprint
		m.blocked = e
		m.blockedFingerprint = s.Fingerprint
		if repeat {
			slog.Warn("time sync settings still not persisted", "fingerprint", s.Fingerprint, "error", e)
			return false, nil
		}
		return false, e
	}
	m.state = next
	m.skipOnce = false
	m.blocked = nil
	m.blockedFingerprint = ""
	return true, nil
}

// rejectionKey is the canonical delivery (json.Marshal sorts map keys), so an
// identical re-delivery is recognised across heartbeats. The reason is left out:
// it is fixed by the payload (parsing is deterministic, and the fingerprint check
// compares against Settings, which only a valid delivery changes — and a valid
// delivery clears lastRejected), so including its text could only let a
// nondeterministic message re-report the same payload.
func rejectionKey(raw any) string {
	b, e := json.Marshal(raw)
	if e != nil {
		// Unreachable for a decoded heartbeat; ParseSettings rejects it the same way.
		return "unencodable\x00" + e.Error()
	}
	return string(b)
}
func (m *Manager) read(ctx context.Context) (Observation, error) { return m.observe(ctx) }
func (m *Manager) reconciler() *Reconciler {
	return &Reconciler{Read: m.read, Writer: m.writer, Now: m.now, Save: m.save, State: &m.state}
}
func (m *Manager) upload(ctx context.Context) error {
	snapshot, e := m.collector.Collect(ctx)
	if e != nil {
		return e
	}
	if snapshot == nil {
		return nil
	}
	snapshot.Enforcement = &EnforcementReport{NTP: m.state.Report.NTP, Timezone: m.state.Report.Timezone}
	// Keep collector-selected events and their private displayReserved flags.
	if e = fitPayload(snapshot); e != nil {
		return e
	}
	if e = m.send(ctx, snapshot); e != nil {
		return e
	}
	return m.collector.Commit(snapshot)
}
func (m *Manager) Cycle(ctx context.Context) error {
	if e := m.lock(ctx); e != nil {
		return e
	}
	defer m.unlock()
	if e := ctx.Err(); e != nil {
		return e
	}
	if m.writer == nil {
		return nil
	}
	if m.blocked != nil {
		return errors.Join(m.blocked, m.upload(ctx))
	}
	// Flush any previous failed result persistence before considering another mutation.
	if e := m.save(m.state); e != nil {
		return e
	}
	var e error
	if m.skipOnce {
		m.skipOnce = false
	} else {
		e = m.reconciler().Run(ctx, false)
	}
	return errors.Join(e, m.upload(ctx))
}
