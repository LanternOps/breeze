package hwhealth

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"

	"github.com/breeze-rmm/agent/internal/collectors"
)

type Options struct {
	DataDir       string
	ExtraToolDirs []string
	Sources       []Source
	Now           func() time.Time
}

type Collector struct {
	mu               sync.Mutex
	flight           sync.Mutex
	config           Config
	revision         uint64
	cancel           context.CancelFunc
	disabledReported bool
	dir              string
	now              func() time.Time
	sources          []Source
	detect           map[Kind]*detection
	breakers         map[Kind]*breaker
	state            diskState
	cache            map[string]smartCacheEntry
	initErr          error
	budget           time.Duration
}

func New(opts Options) *Collector {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	c := &Collector{
		dir:      opts.DataDir,
		now:      opts.Now,
		config:   Config{true, 10 * time.Minute, time.Hour},
		detect:   map[Kind]*detection{},
		breakers: map[Kind]*breaker{},
		cache:    map[string]smartCacheEntry{},
		budget:   4 * time.Minute,
	}
	c.initErr = readJSON(filepath.Join(c.dir, "hwhealth_state.json"), &c.state)
	if c.state.MDMembers == nil {
		c.state.MDMembers = map[string]string{}
	}
	if e := readJSON(filepath.Join(c.dir, "hwhealth_smart_cache.json"), &c.cache); e != nil {
		slog.Warn("hardware SMART cache discarded", "error", e)
		c.cache = map[string]smartCacheEntry{}
	}
	if c.cache == nil {
		c.cache = map[string]smartCacheEntry{}
	}
	c.sources = append([]Source{}, opts.Sources...)
	if opts.Sources == nil && (runtime.GOOS == "windows" || runtime.GOOS == "linux") {
		c.sources = []Source{
			newStorcli("storcli", opts.ExtraToolDirs, runTool),
			newStorcli("perccli", opts.ExtraToolDirs, runTool),
			newMDADM(opts.ExtraToolDirs, runTool, c.state.MDMembers),
			newStorageSpaces(),
			newWinPD(),
			newSMART(opts.ExtraToolDirs, runTool, opts.Now),
		}
	}
	for _, s := range c.sources {
		c.detect[s.Name()] = &detection{}
		c.breakers[s.Name()] = &breaker{}
	}
	return c
}

func (c *Collector) ApplyConfig(cfg Config) {
	if cfg.PollInterval < 5*time.Minute || cfg.PollInterval > 60*time.Minute || cfg.DiskHealthInterval < 15*time.Minute || cfg.DiskHealthInterval > 1440*time.Minute {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if cfg == c.config {
		return
	}
	c.config = cfg
	c.revision++
	c.disabledReported = false
	if c.cancel != nil {
		c.cancel()
	}
}

// The parent `collectors` package does not import `hwhealth`; its exported panic guard is
// safe to consume without an import cycle. Only heartbeat imports both packages.
// `Options.Sources` non-nil empty deliberately disables real probes in tests; nil selects
// platform defaults.

func (c *Collector) Run(parent context.Context, tiers []Tier) (*Snapshot, error) {
	if !c.flight.TryLock() {
		return nil, nil
	}
	defer c.flight.Unlock()
	if c.initErr != nil {
		return nil, c.initErr
	}
	ctx, cancel := context.WithTimeout(parent, c.budget)
	defer cancel()
	c.mu.Lock()
	cfg, revision := c.config, c.revision
	c.cancel = cancel
	disabledReported := c.disabledReported
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.cancel = nil
		c.mu.Unlock()
	}()
	if !cfg.Enabled && disabledReported {
		return nil, nil
	}
	now := c.now().UTC()
	snapshot := &Snapshot{
		SnapshotID:                uuid.NewString(),
		CollectedAt:               now,
		PollIntervalMinutes:       int(cfg.PollInterval / time.Minute),
		DiskHealthIntervalMinutes: int(cfg.DiskHealthInterval / time.Minute),
		TiersRun:                  []string{},
		Sources:                   []SourceReport{},
		Components:                []Component{},
	}
	requested := map[Tier]bool{}
	for _, t := range tiers {
		if t == TierRAID || t == TierDisk {
			requested[t] = true
		}
	}
	available := map[Kind]Availability{}
	anyAvailable := false
	if cfg.Enabled {
		for _, s := range c.sources {
			if ctx.Err() != nil {
				available[s.Name()] = Availability{Available: true}
				anyAvailable = true
				continue
			}
			available[s.Name()] = c.detect[s.Name()].get(now, func() Availability { return s.Detect(ctx) })
			anyAvailable = anyAvailable || available[s.Name()].Available
		}
	}
	noTools := cfg.Enabled && !anyAvailable
	if noTools && !c.state.LastNone.IsZero() && now.Sub(c.state.LastNone) < 24*time.Hour {
		return nil, nil
	}
	if !cfg.Enabled {
		snapshot.TiersRun = []string{"disabled"}
	} else if noTools {
		snapshot.TiersRun = []string{"none"}
	}
	order := append([]Source{}, c.sources...)
	for i, s := range order {
		if s.Name() == c.state.Next {
			order = append(append([]Source{}, order[i:]...), order[:i]...)
			break
		}
	}
	ranTiers := map[Tier]bool{}
	next := Kind("")
	for _, s := range order {
		k := s.Name()
		a := available[k]
		report := SourceReport{Source: k, Path: a.Path, ToolVersion: a.Version}
		if !cfg.Enabled {
			report.Status = "disabled"
			snapshot.Sources = append(snapshot.Sources, report)
			continue
		}
		if !a.Available {
			report.Status = "unavailable"
			snapshot.Sources = append(snapshot.Sources, report)
			continue
		}
		if k == "perccli" && available["storcli"].Available {
			report.Status = "superseded"
			snapshot.Sources = append(snapshot.Sources, report)
			continue
		}
		if !requested[s.Tier()] {
			continue
		}
		ranTiers[s.Tier()] = true
		b := c.breakers[k]
		if b.blocked(now) {
			report.Status = "backing_off"
			report.Error = b.lastError
			report.RetryAt = ptr(b.retryAt)
			snapshot.Sources = append(snapshot.Sources, report)
			continue
		}
		if ctx.Err() != nil {
			report.Status = "failed"
			report.Error = "budget exceeded"
			if next == "" {
				next = k
			}
			snapshot.Sources = append(snapshot.Sources, report)
			continue
		}
		start := time.Now()
		r, e := collectors.Guard("hwhealth."+string(k), func() (Result, error) { return s.Collect(ctx, a) })
		report.DurationMs = time.Since(start).Milliseconds()
		report.Warnings = r.Warnings
		if r.ToolVersion != "" {
			report.ToolVersion = r.ToolVersion
		}
		if e != nil && len(r.Components) == 0 {
			report.Status = "failed"
			report.Error = e.Error()
			b.finish(now, e)
		} else {
			report.Status = "ok"
			report.Complete = ptr(r.Complete && e == nil)
			if e != nil {
				report.Warnings = append(report.Warnings, e.Error())
			}
			snapshot.Components = append(snapshot.Components, r.Components...)
			b.finish(now, nil)
		}
		snapshot.Sources = append(snapshot.Sources, report)
	}
	if cfg.Enabled && !noTools {
		for _, t := range []Tier{TierRAID, TierDisk} {
			if ranTiers[t] {
				snapshot.TiersRun = append(snapshot.TiersRun, string(t))
			}
		}
		if len(snapshot.TiersRun) == 0 {
			return nil, nil
		}
	}
	topology, topologyLimited := boundedVendorTopology(c.state.VendorTopology, snapshot.Components, snapshot.Sources, now, cfg.PollInterval)
	if topologyLimited {
		for i := range snapshot.Sources {
			report := &snapshot.Sources[i]
			if vendorSource(report.Source) && report.Status == "ok" {
				report.Complete = ptr(false)
				report.Warnings = append(report.Warnings, "vendor topology limited; Windows suppression disabled")
			}
		}
	}
	snapshot.Components = merge(snapshot.Components, c.cache, now, cfg.DiskHealthInterval, topology)
	limitSnapshot(snapshot)
	// Cache contains unique serial entries only. Bound retention on many changing devices.
	if len(c.cache) > 64 {
		keys := []string{}
		for k := range c.cache {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return c.cache[keys[i]].ObservedAt.After(c.cache[keys[j]].ObservedAt) })
		for _, k := range keys[64:] {
			delete(c.cache, k)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if revision != c.revision {
		return nil, nil
	}
	if parent.Err() != nil {
		return nil, parent.Err()
	}
	pending := c.state
	pending.VendorTopology = topology
	pending.Next = next
	if noTools {
		pending.LastNone = now
	}
	if e := writeJSON(filepath.Join(c.dir, "hwhealth_smart_cache.json"), c.cache); e != nil {
		return nil, fmt.Errorf("persist hardware SMART cache: %w", e)
	}
	if e := reserveSequence(c.dir, &pending); e != nil {
		return nil, e
	}
	c.state = pending
	snapshot.Sequence = c.state.Sequence
	if !cfg.Enabled {
		c.disabledReported = true
	}
	return snapshot, nil
}

// Zod string .max() uses JavaScript length: UTF-16 code units, not rune count.
func wireStringLen(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

func cut(s string, n int) string {
	units := 0
	for i, r := range s {
		units += utf16.RuneLen(r)
		if units > n {
			return s[:i]
		}
	}
	return s
}

// Runtime version is injected by heartbeat after limitSnapshot; bound it at serialization.
func (s Snapshot) MarshalJSON() ([]byte, error) {
	type wire Snapshot
	out := wire(s)
	out.AgentVersion = cut(out.AgentVersion, 50)
	return json.Marshal(out)
}

func limitSnapshot(s *Snapshot) {
	incomplete := func(k Kind) {
		for i := range s.Sources {
			if s.Sources[i].Source == k && s.Sources[i].Status == "ok" {
				s.Sources[i].Complete = ptr(false)
				s.Sources[i].Warnings = append(s.Sources[i].Warnings, "component output limited")
			}
		}
	}
	kept := []Component{}
	seen := map[string]bool{}
	for _, c := range s.Components {
		if wireStringLen(c.ComponentKey) > 200 || c.ComponentKey == "" || wireStringLen(c.State) > 40 || c.State == "" || seen[c.ComponentKey] || len(kept) >= 2000 {
			incomplete(c.Source)
			continue
		}
		seen[c.ComponentKey] = true
		c.Name = cut(c.Name, 200)
		if c.Name == "" {
			c.Name = c.ComponentKey
		}
		for _, p := range []*string{c.Model, c.Serial, c.StateDetail} {
			if p != nil {
				*p = cut(*p, 200)
			}
		}
		if c.Firmware != nil {
			*c.Firmware = cut(*c.Firmware, 100)
		}
		if c.ParentKey != nil && wireStringLen(*c.ParentKey) > 200 {
			c.ParentKey = nil
			incomplete(c.Source)
		}
		if c.TemperatureC != nil && (*c.TemperatureC < -50 || *c.TemperatureC > 200) {
			c.TemperatureC = nil
		}
		if c.ProgressPercent != nil && (*c.ProgressPercent < 0 || *c.ProgressPercent > 100) {
			c.ProgressPercent = nil
		}
		if c.Attributes == nil {
			c.Attributes = map[string]any{}
		}
		b, e := json.Marshal(c.Attributes)
		if e != nil || len(b) > 8192 {
			c.Attributes = map[string]any{}
			incomplete(c.Source)
		}
		kept = append(kept, c)
	}
	s.Components = kept
	for i := range s.Sources {
		r := &s.Sources[i]
		r.Path = cut(r.Path, 500)
		r.ToolVersion = cut(r.ToolVersion, 100)
		r.Error = cut(r.Error, 500)
		if len(r.Warnings) > 50 {
			r.Warnings = r.Warnings[:50]
		}
		for j := range r.Warnings {
			r.Warnings[j] = cut(r.Warnings[j], 500)
		}
	}
	for len(s.Components) > 0 {
		b, e := json.Marshal(s)
		if e == nil && len(b) < 2*1024*1024-1024 {
			break
		}
		last := s.Components[len(s.Components)-1]
		incomplete(last.Source)
		s.Components = s.Components[:len(s.Components)-1]
	}
	for i := range s.Sources {
		if len(s.Sources[i].Warnings) > 50 {
			s.Sources[i].Warnings = s.Sources[i].Warnings[:50]
		}
	}
}
