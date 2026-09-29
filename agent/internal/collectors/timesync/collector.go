package timesync

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Collector struct {
	mu     sync.Mutex
	dir    string
	sys    System
	now    func() time.Time
	save   func(string, any) error
	loaded bool
	state  diskState
}

func New(stateDir string, sys System) *Collector {
	return &Collector{dir: stateDir, sys: sys, now: time.Now, save: writeState}
}
func (c *Collector) Collect(ctx context.Context) (*Snapshot, error) {
	if c.sys == nil {
		return nil, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	now := c.now().UTC()
	if !c.loaded {
		state, err := readState(filepath.Join(c.dir, stateName), now)
		if err != nil {
			return nil, err
		}
		c.state = state
		c.loaded = true
	}
	if c.state.Sequence >= maxSafeSequence {
		return nil, fmt.Errorf("time sync sequence exhausted")
	}
	since := c.state.EventsSince
	if since.IsZero() || since.After(now) {
		since = now.Add(-24 * time.Hour)
	}
	events, err := collectEvents(ctx, c.sys, since, now)
	if err != nil {
		return nil, err
	}
	s := emptySnapshot(now)
	s.Sequence = c.state.Sequence + 1
	s.Events = events
	s.Config = readConfig(ctx, c.sys)
	s.Domain = readDomain(ctx, c.sys)
	s.Status = readStatus(ctx, c.sys, events)
	if zone, e := c.sys.DynamicTimezone(ctx); e == nil {
		s.Timezone = zone
		s.Timezone.AutoUpdate = "unknown"
	}
	if start, e := c.sys.ReadDWORD(ctx, `SYSTEM\CurrentControlSet\Services\tzautoupdate`, "Start"); e == nil {
		switch start {
		case 3:
			s.Timezone.AutoUpdate = "on"
		case 4:
			s.Timezone.AutoUpdate = "off"
		}
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = fitPayload(&s); err != nil {
		return nil, err
	}
	next := c.state
	next.Sequence = s.Sequence
	if err = c.save(filepath.Join(c.dir, stateName), next); err != nil {
		return nil, err
	}
	c.state = next
	return &s, nil
}
func (c *Collector) Commit(snapshot *Snapshot) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.loaded || snapshot == nil || snapshot.SchemaVersion != 1 || snapshot.Sequence == 0 || snapshot.Sequence > c.state.Sequence || snapshot.CollectedAt.IsZero() {
		return fmt.Errorf("invalid time sync commit")
	}
	// Delayed commits are idempotent and cannot rewind an already committed boundary.
	if !snapshot.CollectedAt.After(c.state.EventsSince) {
		return nil
	}
	next := c.state
	next.EventsSince = snapshot.CollectedAt.UTC()
	if err := c.save(filepath.Join(c.dir, stateName), next); err != nil {
		return err
	}
	c.state = next
	return nil
}
func readConfig(ctx context.Context, sys System) Config {
	c := Config{ServiceState: "unknown", ServiceStartType: "unknown", PolicyManagedValues: []string{}}
	if value, err := sys.ReadString(ctx, serviceKey+`\Parameters`, "Type"); err == nil {
		switch value {
		case "NT5DS", "NTP", "NoSync", "AllSync":
			c.Type = ptr(value)
		}
	}
	if value, err := sys.ReadString(ctx, serviceKey+`\Parameters`, "NtpServer"); err == nil && strings.TrimSpace(value) != "" {
		c.NtpServer = ptr(limitText(value, 1024))
	}
	if value, err := sys.ReadDWORD(ctx, serviceKey+`\TimeProviders\NtpClient`, "SpecialPollInterval"); err == nil {
		c.SpecialPollIntervalSeconds = ptr(value)
	}
	if value, err := sys.ReadDWORD(ctx, serviceKey+`\TimeProviders\VMICTimeProvider`, "Enabled"); err == nil && value <= 1 {
		c.HostTimeProviderEnabled = ptr(value == 1)
	}
	values := map[string]bool{}
	for _, suffix := range []string{`\Parameters`, `\TimeProviders\NtpClient`} {
		names, err := sys.ValueNames(ctx, policyKey+suffix)
		if err != nil {
			c.PolicyManaged = true
		}
		for _, name := range names {
			if name != "" {
				values[limitText(name, 64)] = true
				c.PolicyManaged = true
			}
		}
	}
	for name := range values {
		c.PolicyManagedValues = append(c.PolicyManagedValues, name)
	}
	sort.Strings(c.PolicyManagedValues)
	if len(c.PolicyManagedValues) > 20 {
		c.PolicyManagedValues = c.PolicyManagedValues[:20]
	}
	if service, err := sys.W32TimeService(ctx); err == nil {
		c.ServiceState = service.State
		c.ServiceStartType = service.StartType
	}
	return c
}

const maxPayloadBytes = 256 * 1024

func fitPayload(s *Snapshot) error {
	for {
		b, err := json.Marshal(s)
		if err != nil {
			return err
		}
		if len(b) <= maxPayloadBytes {
			return nil
		}
		// Events are newest first. Remove only unreserved rows, oldest first.
		removable := -1
		for i := len(s.Events) - 1; i >= 0; i-- {
			if !s.Events[i].displayReserved {
				removable = i
				break
			}
		}
		if removable >= 0 {
			s.Events = append(s.Events[:removable], s.Events[removable+1:]...)
			continue
		}
		// Even 20 capped rows can exceed the byte budget after JSON escaping.
		// Preserve every reserved ID/time/level, property position and the first
		// insertion string (source evidence). Reduce display text and remaining
		// insertion-string lengths until the serialized body fits.
		changed := false
		shrink := func(value string) string {
			if value == "" {
				return value
			}
			changed = true
			return limitText(value, len([]rune(value))/2)
		}
		for i := range s.Events {
			s.Events[i].Message = shrink(s.Events[i].Message)
			for j := 1; j < len(s.Events[i].Properties); j++ {
				s.Events[i].Properties[j] = shrink(s.Events[i].Properties[j])
			}
		}
		if !changed {
			return fmt.Errorf("time sync base payload and reserved event metadata exceed 256 KiB")
		}
	}
}
