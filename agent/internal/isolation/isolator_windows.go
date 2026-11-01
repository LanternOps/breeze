//go:build windows

package isolation

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/wfp"
	"github.com/breeze-rmm/agent/internal/serviceinstall"
)

type windowsWFPSession interface {
	Close() error
	Tx(func(*wfp.Tx) error) error
	EnumOwned() ([]wfp.FilterInfo, error)
}

type windowsDropWindow struct {
	marker      Marker
	events      <-chan wfp.DropEvent
	cancel      func()
	stopTimer   func() bool
	stopContext func() bool
}

type windowsIsolator struct {
	bins       func() []string
	open       func() (windowsWFPSession, error)
	appID      func(string) ([]byte, error)
	stat       func(string) error
	baseline   func() (Baseline, error)
	subscribe  func([]uint64) (<-chan wfp.DropEvent, func(), error)
	mu         sync.Mutex
	nextMarker uint64
	window     *windowsDropWindow
}

// windowsBinaryNames are the installed Breeze binaries that get app-scoped permits.
var windowsBinaryNames = []string{
	"breeze-agent.exe", "breeze-watchdog.exe", "breeze-desktop-helper.exe",
	"breeze-user-helper.exe", "breeze-backup.exe",
}

// NewPlatformIsolator provides real WFP release and inspection, even while
// capability remains zero. An older build must still release inherited rules.
func NewPlatformIsolator() Isolator { return newWindowsIsolator(nil) }

func newWindowsIsolator(bins func() []string) Isolator {
	if bins == nil {
		bins = func() []string {
			paths := make([]string, 0, len(windowsBinaryNames))
			for _, name := range windowsBinaryNames {
				path, err := serviceinstall.ProtectedBinaryPath(name)
				if err != nil {
					log.Warn("cannot choose isolation binary path", "error", err)
					return nil
				}
				paths = append(paths, path)
			}
			return paths
		}
	}
	return &windowsIsolator{
		bins:  bins,
		open:  func() (windowsWFPSession, error) { return wfp.OpenSession() },
		appID: wfp.AppIDFromPath,
		stat: func(path string) error {
			info, err := os.Stat(path)
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("binary %q is not a regular file", path)
			}
			return nil
		},
		baseline:  readWindowsBaseline,
		subscribe: wfp.SubscribeClassifyDrops,
	}
}

// Capability deliberately stays disabled until recovery distribution and the
// Windows lab gate land in W1g; inspection and release are still functional.
func (*windowsIsolator) Capability() Capability {
	return Capability{Version: 0, Mechanism: "wfp", UnsupportedReason: "wfp isolator not activated in this agent build", Ready: false}
}

func closeWindowsSession(s windowsWFPSession) {
	if err := s.Close(); err != nil {
		log.Warn("close isolation WFP session", "error", err)
	}
}

func (i *windowsIsolator) applicationIDs() ([]string, map[string][]byte, error) {
	ids := map[string][]byte{}
	var bins []string
	hasAgent := false
	for _, path := range canonicalWindowsPaths(i.bins()) {
		isAgent := filepath.Base(path) == "breeze-agent.exe"
		if err := i.stat(path); err != nil {
			if !isAgent && errors.Is(err, os.ErrNotExist) {
				log.Warn("skipping missing isolation helper binary", "path", path)
				continue
			}
			return nil, nil, fmt.Errorf("isolation binary %q: %w", path, err)
		}
		id, err := i.appID(path)
		if err != nil {
			return nil, nil, fmt.Errorf("resolve isolation app ID %q: %w", path, err)
		}
		if len(id) == 0 {
			return nil, nil, fmt.Errorf("empty isolation app ID for %q", path)
		}
		ids[path] = id
		bins = append(bins, path)
		hasAgent = hasAgent || isAgent
	}
	if !hasAgent {
		return nil, nil, errors.New("breeze-agent.exe has no WFP app ID")
	}
	return bins, ids, nil
}

// Apply replaces both address families and both lifetimes in one transaction,
// then hashes what BFE actually installed rather than merely the requested spec.
func (i *windowsIsolator) Apply(ctx context.Context, spec ResolvedSpec) (Digest, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	bins, ids, err := i.applicationIDs()
	if err != nil {
		return "", err
	}
	baseline, err := i.baseline()
	if err != nil {
		return "", fmt.Errorf("read Windows isolation baseline: %w", err)
	}
	rules := buildWindowsRules(spec, bins, nil, baseline)
	for n := range rules {
		for c := range rules[n].Conditions {
			cond := &rules[n].Conditions[c]
			if cond.Field == wfp.AppID {
				cond.AppID = ids[cond.AppPath]
			}
		}
		if err := rules[n].Validate(); err != nil {
			return "", fmt.Errorf("validate WFP policy: %w", err)
		}
	}
	s, err := i.open()
	if err != nil {
		return "", err
	}
	defer closeWindowsSession(s)
	if err := s.Tx(func(tx *wfp.Tx) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := tx.DeleteOwned(); err != nil {
			return err
		}
		if err := tx.AddProvider(true); err != nil {
			return err
		}
		if err := tx.AddSublayer(wfp.SublayerWeight, true); err != nil {
			return err
		}
		for _, f := range rules {
			if err := ctx.Err(); err != nil {
				return err
			}
			if _, err := tx.AddFilter(f); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return "", fmt.Errorf("apply WFP isolation transaction: %w", err)
	}
	// Existing IPv4 TCP connections are removed explicitly; IPv6 is left to
	// ALE reauthorization. Reset errors cannot undo the committed WFP policy.
	teardownWindowsTCP(spec, bins, baseline)
	installed, err := s.EnumOwned()
	if err != nil {
		return "", fmt.Errorf("read back WFP isolation: %w", err)
	}
	digest := wfp.CanonicalDigest(installed)
	if err := validateWindowsReadback(rules, installed); err != nil {
		return "", err
	}
	return Digest(digest), nil
}

// Verify reads actual engine state so an external policy change alters the digest.
func (i *windowsIsolator) Verify(ctx context.Context, _ ResolvedSpec) (Digest, error) {
	filters, err := i.ownedFilters(ctx)
	if err != nil {
		return "", err
	}
	return Digest(wfp.CanonicalDigest(filters)), nil
}

// Release confirms absence after deletion; an inaccessible engine is never a
// successful release, even when this build cannot apply new isolation.
func (i *windowsIsolator) Release(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	i.mu.Lock()
	i.stopWindowLocked()
	i.mu.Unlock()
	s, err := i.open()
	if err != nil {
		return err
	}
	defer closeWindowsSession(s)
	if err := s.Tx(func(tx *wfp.Tx) error { return tx.DeleteOwned() }); err != nil {
		return fmt.Errorf("release WFP isolation: %w", err)
	}
	filters, err := s.EnumOwned()
	if err != nil {
		return fmt.Errorf("confirm WFP isolation release: %w", err)
	}
	if len(filters) != 0 {
		return fmt.Errorf("release left %d Breeze-owned WFP filters", len(filters))
	}
	return nil
}

func (i *windowsIsolator) ownedFilters(ctx context.Context) ([]wfp.FilterInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s, err := i.open()
	if err != nil {
		return nil, err
	}
	defer closeWindowsSession(s)
	return s.EnumOwned()
}

// Owned reports only observed absence, preserving errors from BFE enumeration.
func (i *windowsIsolator) Owned(ctx context.Context) (bool, error) {
	filters, err := i.ownedFilters(ctx)
	if err != nil {
		return false, err
	}
	return len(filters) > 0, nil
}

// Mark opens a bounded net-event window for the installed block-all filter IDs.
func (i *windowsIsolator) Mark(ctx context.Context) (Marker, error) {
	filters, err := i.ownedFilters(ctx)
	if err != nil {
		return Marker{}, err
	}
	var ids []uint64
	for _, f := range filters {
		if f.Action == wfp.Block && !f.BootTime && len(f.Conditions) == 0 {
			ids = append(ids, f.ID)
		}
	}
	if len(ids) == 0 {
		return Marker{}, errors.New("no installed WFP block-all filters to observe")
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.stopWindowLocked()
	events, cancel, err := i.subscribe(ids)
	if err != nil {
		return Marker{}, fmt.Errorf("subscribe WFP classify drops: %w", err)
	}
	i.nextMarker++
	marker := Marker{Value: i.nextMarker, At: time.Now()}
	i.window = &windowsDropWindow{marker: marker, events: events, cancel: cancel}
	// The negative probe can return before DropObserved (e.g. a successful
	// connect or RST). Bound collection even on those paths without changing
	// the shared probe interface. The default SYN timeout is three seconds.
	i.window.stopTimer = time.AfterFunc(NegativeProbeTimeout+2*time.Second, func() { i.expireWindow(marker) }).Stop
	i.window.stopContext = context.AfterFunc(ctx, func() { i.expireWindow(marker) })
	return marker, nil
}

func (i *windowsIsolator) expireWindow(marker Marker) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.window != nil && i.window.marker == marker {
		i.stopWindowLocked()
	}
}

func (i *windowsIsolator) stopWindowLocked() {
	if i.window == nil {
		return
	}
	w := i.window
	i.window = nil
	if w.stopTimer != nil {
		w.stopTimer()
	}
	if w.stopContext != nil {
		w.stopContext()
	}
	w.cancel()
}

// DropObserved consumes a single probe window and restores net-event collection.
func (i *windowsIsolator) DropObserved(ctx context.Context, since Marker) (bool, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.window == nil || i.window.marker != since {
		return false, errors.New("WFP drop marker expired or unknown")
	}
	defer i.stopWindowLocked()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	// RPC callback delivery may trail the failed socket call slightly.
	timer := time.NewTimer(250 * time.Millisecond)
	defer timer.Stop()
	select {
	case _, ok := <-i.window.events:
		if !ok {
			return false, errors.New("WFP classify-drop subscription ended")
		}
		return true, nil
	case <-ctx.Done():
		return false, ctx.Err()
	case <-timer.C:
		return false, nil
	}
}
