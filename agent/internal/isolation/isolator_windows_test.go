//go:build windows

package isolation

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/wfp"
)

func TestWindowsCapabilityStaysDisabled(t *testing.T) {
	iso := newWindowsIsolator(func() []string { t.Fatal("capability must not inspect files"); return nil })
	got := iso.Capability()
	if got.Version != 0 || got.Mechanism != "wfp" || got.Ready || got.UnsupportedReason == "" {
		t.Fatalf("capability activated prematurely: %+v", got)
	}
}

func TestWindowsBinaryNames(t *testing.T) {
	want := []string{"breeze-agent.exe", "breeze-watchdog.exe", "breeze-desktop-helper.exe", "breeze-user-helper.exe", "breeze-backup.exe"}
	if !reflect.DeepEqual(windowsBinaryNames, want) {
		t.Fatalf("binaries: %v", windowsBinaryNames)
	}
}

type fakeWindowsSession struct {
	filters      []wfp.FilterInfo
	err          error
	transactions int
}

func (s *fakeWindowsSession) Close() error                         { return nil }
func (s *fakeWindowsSession) EnumOwned() ([]wfp.FilterInfo, error) { return s.filters, s.err }
func (s *fakeWindowsSession) Tx(_ func(*wfp.Tx) error) error       { s.transactions++; return s.err }

func TestWindowsOwnedVerifyAndReleaseReadBack(t *testing.T) {
	sentinel := errors.New("BFE unavailable")
	s := &fakeWindowsSession{err: sentinel}
	i := newWindowsIsolator(nil).(*windowsIsolator)
	i.open = func() (windowsWFPSession, error) { return s, nil }
	if owned, err := i.Owned(context.Background()); owned || !errors.Is(err, sentinel) {
		t.Fatalf("Owned lost error: %v %v", owned, err)
	}
	if _, err := i.Verify(context.Background(), ResolvedSpec{}); !errors.Is(err, sentinel) {
		t.Fatalf("Verify lost error: %v", err)
	}
	if err := i.Release(context.Background()); !errors.Is(err, sentinel) {
		t.Fatalf("Release lost error: %v", err)
	}
	s.err = nil
	s.filters = []wfp.FilterInfo{{Filter: wfp.Filter{Key: wfp.FilterKey("test"), Action: wfp.Block}, ID: 12}}
	if owned, err := i.Owned(context.Background()); !owned || err != nil {
		t.Fatalf("Owned: %v %v", owned, err)
	}
	if got, err := i.Verify(context.Background(), ResolvedSpec{}); got != Digest(wfp.CanonicalDigest(s.filters)) || err != nil {
		t.Fatalf("digest: %s %v", got, err)
	}
	if err := i.Release(context.Background()); err == nil {
		t.Fatal("release confirmed while rules remained")
	}
	s.filters = nil
	if err := i.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsAppIDsRequireAgentAndSkipMissingHelpers(t *testing.T) {
	i := newWindowsIsolator(func() []string { return []string{`C:\Breeze\breeze-agent.exe`, `C:\Breeze\breeze-backup.exe`} }).(*windowsIsolator)
	i.stat = func(path string) error {
		if path == `c:\breeze\breeze-agent.exe` {
			return nil
		}
		return os.ErrNotExist
	}
	i.appID = func(path string) ([]byte, error) {
		if path == `c:\breeze\breeze-agent.exe` {
			return []byte{1, 2}, nil
		}
		return nil, errors.New("missing")
	}
	bins, ids, err := i.applicationIDs()
	if err != nil || len(bins) != 1 || len(ids[bins[0]]) == 0 {
		t.Fatalf("app IDs %v %v %v", bins, ids, err)
	}
	i.appID = func(string) ([]byte, error) { return nil, errors.New("missing") }
	if _, _, err := i.applicationIDs(); err == nil {
		t.Fatal("missing agent app-ID accepted")
	}
	i.bins = func() []string { return nil }
	if _, _, err := i.applicationIDs(); err == nil {
		t.Fatal("empty binary set accepted")
	}
}

func TestWindowsApplyRefusesUnusableAgentBeforeOpeningWFP(t *testing.T) {
	i := newWindowsIsolator(func() []string { return []string{`C:\Breeze\breeze-agent.exe`} }).(*windowsIsolator)
	i.stat = func(string) error { return os.ErrNotExist }
	i.open = func() (windowsWFPSession, error) { t.Fatal("opened WFP without usable agent app ID"); return nil, nil }
	if _, err := i.Apply(context.Background(), ResolvedSpec{}); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing agent: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := i.Apply(ctx, ResolvedSpec{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled apply: %v", err)
	}
}

func TestWindowsDropSubscriptionFailureAndCleanup(t *testing.T) {
	i := newWindowsIsolator(nil).(*windowsIsolator)
	s := &fakeWindowsSession{filters: []wfp.FilterInfo{{Filter: wfp.Filter{Action: wfp.Block}, ID: 42}}}
	i.open = func() (windowsWFPSession, error) { return s, nil }
	i.subscribe = func([]uint64) (<-chan wfp.DropEvent, func(), error) {
		return nil, nil, errors.New("subscription unavailable")
	}
	if _, err := i.Mark(context.Background()); err == nil {
		t.Fatal("subscription failure accepted")
	}
	events := make(chan wfp.DropEvent, 1)
	cancelled := 0
	i.subscribe = func(ids []uint64) (<-chan wfp.DropEvent, func(), error) {
		if !reflect.DeepEqual(ids, []uint64{42}) {
			t.Fatalf("wrong drop ids: %v", ids)
		}
		return events, func() { cancelled++ }, nil
	}
	mark, err := i.Mark(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	events <- wfp.DropEvent{FilterID: 42}
	if got, err := i.DropObserved(context.Background(), mark); !got || err != nil {
		t.Fatalf("drop: %v %v", got, err)
	}
	if cancelled != 1 {
		t.Fatalf("collection not restored: %d", cancelled)
	}
	if _, err := i.DropObserved(context.Background(), mark); err == nil {
		t.Fatal("stale marker accepted")
	}
}

func TestWindowsDropWindowClosesOnContextCancellation(t *testing.T) {
	i := newWindowsIsolator(nil).(*windowsIsolator)
	i.open = func() (windowsWFPSession, error) {
		return &fakeWindowsSession{filters: []wfp.FilterInfo{{Filter: wfp.Filter{Action: wfp.Block}, ID: 1}}}, nil
	}
	cancelled := make(chan struct{})
	i.subscribe = func([]uint64) (<-chan wfp.DropEvent, func(), error) {
		return make(chan wfp.DropEvent), func() { close(cancelled) }, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := i.Mark(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("probe window leaked")
	}
}
