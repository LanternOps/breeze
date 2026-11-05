package oemupdates

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/breeze-rmm/agent/internal/authenticode"
)

var memStoreSeq atomic.Int64

// memStore is an in-memory Store. Dir hands out real temp directories so a
// fake Exec can write a log where a lane will read it.
type memStore struct {
	key   string
	mu    sync.Mutex
	files map[string][]byte
	root  string

	failWrite error
}

func newMemStore() *memStore {
	return &memStore{key: fmt.Sprintf("mem-%d", memStoreSeq.Add(1)), files: map[string][]byte{}}
}

func (s *memStore) Key() string { return s.key }

func (s *memStore) ReadFile(name string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.files[name]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func (s *memStore) WriteFile(name string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWrite != nil {
		return s.failWrite
	}
	s.files[name] = append([]byte(nil), data...)
	return nil
}

func (s *memStore) Remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.files, name)
	return nil
}

func (s *memStore) Dir(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.root == "" {
		root, err := os.MkdirTemp("", "oemstore-")
		if err != nil {
			return "", err
		}
		s.root = root
	}
	dir := filepath.Join(s.root, name)
	return dir, os.MkdirAll(dir, 0o700)
}

// fakeExec records every process and answers from a script.
type fakeExec struct {
	mu    sync.Mutex
	calls []ExecSpec
	// run answers a call; nil exits 0.
	run func(ctx context.Context, spec ExecSpec) (ExecResult, error)
}

func (e *fakeExec) Run(ctx context.Context, spec ExecSpec) (ExecResult, error) {
	e.mu.Lock()
	e.calls = append(e.calls, ExecSpec{Path: spec.Path, Args: append([]string(nil), spec.Args...)})
	run := e.run
	e.mu.Unlock()
	if run == nil {
		return ExecResult{}, nil
	}
	return run(ctx, spec)
}

func (e *fakeExec) Calls() []ExecSpec {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]ExecSpec(nil), e.calls...)
}

// fakeVerifier signs every path with one publisher unless told otherwise.
type fakeVerifier struct {
	mu        sync.Mutex
	publisher string
	byPath    map[string]string
	err       error
	verified  []string
}

func (v *fakeVerifier) Verify(path string) (authenticode.Signer, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.verified = append(v.verified, path)
	if v.err != nil {
		return authenticode.Signer{}, v.err
	}
	if p, ok := v.byPath[path]; ok {
		return authenticode.Signer{Subject: p}, nil
	}
	return authenticode.Signer{Subject: v.publisher}, nil
}

func (v *fakeVerifier) Verified() []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return append([]string(nil), v.verified...)
}

// fakeFetcher writes a stub file at dest, or fails for listed urls.
type fakeFetcher struct {
	mu      sync.Mutex
	fail    map[string]error
	fetched []string
	allows  map[string]LaneAllowlist
}

func (f *fakeFetcher) Fetch(_ context.Context, url, _ string, allow LaneAllowlist, dest string) error {
	f.mu.Lock()
	f.fetched = append(f.fetched, url)
	if f.allows == nil {
		f.allows = map[string]LaneAllowlist{}
	}
	f.allows[url] = allow
	err := f.fail[url]
	f.mu.Unlock()
	if err != nil {
		return err
	}
	return os.WriteFile(dest, []byte("installer"), 0o600)
}

func (f *fakeFetcher) Fetched() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.fetched...)
}

// fakeLane is a configurable lane. Its tool "installs" when its installer runs.
type fakeLane struct {
	id      string
	gate    *ToolGate
	allow   LaneAllowlist
	rng     VersionRange
	mu      sync.Mutex
	tool    ToolState // what detect returns
	prereqs map[string]*fakePrereq
	apply   func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error)
	applied []FilterPlan
	detects atomic.Int64
	// onInstall is what the installed tool becomes when its installer runs.
	onInstall *ToolState
	// freshVersion, when set, is what a fresh read of the tool's file
	// returns, standing in for a binary replaced since the gate cached it.
	freshVersion string
	// outsideFilter makes the lane report that it may flash firmware the
	// category filter cannot exclude (Dell docks).
	outsideFilter bool
	// filter overrides Filter.
	filter func(cats, blocked []string) (FilterPlan, error)
}

var fakePrereqAllow = LaneAllowlist{Publishers: []string{"Microsoft Corporation"}, Hosts: []string{"builds.dotnet.microsoft.com"}}

func (l *fakeLane) ToolVersion(path string) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.freshVersion != "" {
		return l.freshVersion, nil
	}
	return l.tool.Version, nil
}

func (l *fakeLane) FlashesOutsideFilter() bool { return l.outsideFilter }

type fakePrereq struct {
	installed string
	becomes   string
}

func newFakeLane() *fakeLane {
	l := &fakeLane{
		id:      LaneDell,
		allow:   LaneAllowlist{Publishers: []string{"Dell Inc"}, Hosts: []string{"dl.dell.com"}},
		rng:     VersionRange{Min: "5.7.1", MaxExclusive: "6.0.0"},
		prereqs: map[string]*fakePrereq{},
	}
	l.gate = NewToolGate("fake", func() ToolState {
		l.detects.Add(1)
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.tool
	})
	return l
}

func (l *fakeLane) setTool(s ToolState) {
	l.mu.Lock()
	l.tool = s
	l.mu.Unlock()
}

func (l *fakeLane) ID() string           { return l.id }
func (l *fakeLane) Gate() *ToolGate      { return l.gate }
func (l *fakeLane) Allow() LaneAllowlist { return l.allow }
func (l *fakeLane) Range() VersionRange  { return l.rng }
func (l *fakeLane) SkippedForNoReboot() []string {
	return []string{CategoryBIOS, CategoryFirmware}
}
func (l *fakeLane) Filter(cats, blocked []string) (FilterPlan, error) {
	if l.filter != nil {
		return l.filter(cats, blocked)
	}
	return FilterPlan{Categories: append([]string(nil), cats...), BlockedIDs: blocked}, nil
}
func (l *fakeLane) Apply(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
	l.mu.Lock()
	l.applied = append(l.applied, plan)
	apply := l.apply
	l.mu.Unlock()
	if apply != nil {
		return apply(ctx, tool, plan, ex)
	}
	if _, err := ex.Run(ctx, ExecSpec{Path: tool.Path, Args: []string{"/apply"}}); err != nil {
		return RunResult{Lane: l.id, Outcome: OutcomeFailed}, err
	}
	return RunResult{Lane: l.id, Outcome: OutcomeSuccess}, nil
}
func (l *fakeLane) Applied() []FilterPlan {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]FilterPlan(nil), l.applied...)
}
func (l *fakeLane) InstallArgs(installer, logPath string) []string {
	return []string{"/s", "/l=" + logPath}
}
func (l *fakeLane) Prerequisite(name string) (PrerequisiteHandler, bool) {
	p, ok := l.prereqs[name]
	if !ok {
		return PrerequisiteHandler{}, false
	}
	return PrerequisiteHandler{
		Allow:       fakePrereqAllow,
		Installed:   func() string { l.mu.Lock(); defer l.mu.Unlock(); return p.installed },
		InstallArgs: func(installer, logPath string) []string { return []string{"/install", "/quiet", "/norestart"} },
	}, true
}

// installingExec makes the fake lane's tool and prerequisites appear when their
// installers run, the way a real silent install would.
func installingExec(l *fakeLane, inner func(ctx context.Context, spec ExecSpec) (ExecResult, error)) *fakeExec {
	return &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		l.mu.Lock()
		switch {
		case len(spec.Args) > 0 && spec.Args[0] == "/s" && l.onInstall != nil:
			l.tool = *l.onInstall
		case len(spec.Args) > 0 && spec.Args[0] == "/install":
			for _, p := range l.prereqs {
				if p.becomes != "" {
					p.installed = p.becomes
				}
			}
		}
		l.mu.Unlock()
		if inner != nil {
			return inner(ctx, spec)
		}
		return ExecResult{}, nil
	}}
}

// verifierFunc names the signer of a path.
type verifierFunc func(path string) (string, error)

func (f verifierFunc) Verify(path string) (authenticode.Signer, error) {
	subject, err := f(path)
	return authenticode.Signer{Subject: subject}, err
}

func readDirNames(t interface{ Helper() }, dir string) []string {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}
