package collectors

import (
	"log/slog"
	"strings"
	"sync"
	"time"
)

// This file is platform-neutral so the Windows link-speed mapping is unit
// tested on every OS; only the MIB_IF_TABLE2 reader is Windows-specific
// (bandwidth_windows.go). See #9267.

// ifLinkSpeedUnknown is NDIS_LINK_SPEED_UNKNOWN: MIB_IF_ROW2 reports it for
// adapters whose speed is not known (typically disconnected media).
const ifLinkSpeedUnknown = ^uint64(0)

// linkSpeedTableTTL bounds how long one interface-table snapshot is reused.
// MetricsCollector already caches each interface's speed for speedCacheTTL;
// this short window only makes all adapters looked up in one metrics cycle
// share a single GetIfTable2Ex call instead of one call per adapter.
const linkSpeedTableTTL = 30 * time.Second

// ifLinkSpeedRow is the subset of a Windows MIB_IF_ROW2 the lookup needs.
type ifLinkSpeedRow struct {
	Alias             string
	Description       string
	ReceiveLinkSpeed  uint64
	TransmitLinkSpeed uint64
}

// rowLinkSpeed returns the row's link speed in bits/sec, preferring
// ReceiveLinkSpeed (the value Get-NetAdapter reported before #9267) and
// falling back to TransmitLinkSpeed. Unknown or zero yields 0.
func rowLinkSpeed(r ifLinkSpeedRow) uint64 {
	for _, s := range [...]uint64{r.ReceiveLinkSpeed, r.TransmitLinkSpeed} {
		if s != 0 && s != ifLinkSpeedUnknown {
			return s
		}
	}
	return 0
}

// linkSpeedTable maps interface names to link speeds. Keys are lower-cased:
// Windows interface aliases are case-insensitive.
type linkSpeedTable struct {
	byAlias       map[string]uint64
	byDescription map[string]uint64
}

func newLinkSpeedTable(rows []ifLinkSpeedRow) linkSpeedTable {
	t := linkSpeedTable{
		byAlias:       make(map[string]uint64, len(rows)),
		byDescription: make(map[string]uint64, len(rows)),
	}
	for _, r := range rows {
		speed := rowLinkSpeed(r)
		if speed == 0 {
			continue
		}
		// First known speed wins so the result does not depend on later
		// duplicate rows (e.g. NDIS filter pseudo-interfaces).
		if k := strings.ToLower(r.Alias); k != "" {
			if _, ok := t.byAlias[k]; !ok {
				t.byAlias[k] = speed
			}
		}
		if k := strings.ToLower(r.Description); k != "" {
			if _, ok := t.byDescription[k]; !ok {
				t.byDescription[k] = speed
			}
		}
	}
	return t
}

// lookup returns the speed for name, matching the interface alias first (what
// gopsutil reports as the interface name on Windows) and the adapter
// description second. 0 means unknown.
func (t linkSpeedTable) lookup(name string) uint64 {
	k := strings.ToLower(name)
	if k == "" {
		return 0
	}
	if s, ok := t.byAlias[k]; ok {
		return s
	}
	return t.byDescription[k]
}

// linkSpeedSource serves per-interface lookups from one interface-table
// snapshot, re-reading it at most once per ttl. A failed read is also held
// for ttl (yielding 0) so a broken API is not re-queried for every adapter.
type linkSpeedSource struct {
	read func() ([]ifLinkSpeedRow, error)
	ttl  time.Duration
	now  func() time.Time

	mu     sync.Mutex
	table  linkSpeedTable
	readAt time.Time
	loaded bool
}

func (s *linkSpeedSource) speed(name string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if !s.loaded || now.Sub(s.readAt) >= s.ttl {
		rows, err := s.read()
		if err != nil {
			// Warn: a 0 here is cached per interface for speedCacheTTL, so this
			// logs at most about once per 5 minutes while the read keeps failing.
			slog.Warn("interface table read failed; link speeds reported as unknown", "error", err.Error())
			rows = nil
		}
		s.table = newLinkSpeedTable(rows)
		s.readAt = now
		s.loaded = true
	}
	return s.table.lookup(name)
}
