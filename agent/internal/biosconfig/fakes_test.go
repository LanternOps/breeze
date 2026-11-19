package biosconfig

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type fakeCall struct {
	script string
	stdin  []byte
}

// fakeRunner stands in for PowerShell: it answers each known script with a
// canned stdout and records every call.
type fakeRunner struct {
	mu    sync.Mutex
	out   map[string][]byte
	errs  map[string]error
	calls []fakeCall
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{out: map[string][]byte{}, errs: map[string]error{}}
}

func (f *fakeRunner) run(_ context.Context, script string, stdin []byte) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fakeCall{script: script, stdin: append([]byte(nil), stdin...)})
	if err := f.errs[script]; err != nil {
		return nil, err
	}
	return f.out[script], nil
}

func (f *fakeRunner) Calls() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeCall(nil), f.calls...)
}

// fixture reads a doc-derived file and drops its _source note, which the real
// script never emits.
func fixture(t *testing.T, parts ...string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(append([]string{"testdata"}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	delete(m, "_source")
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func observer(t *testing.T, a Adapter) Observer {
	t.Helper()
	if a == nil {
		t.Fatal("Detect returned nil")
	}
	o, ok := a.(Observer)
	if !ok {
		t.Fatalf("%T is not an Observer", a)
	}
	return o
}

func settingNames(s []ObservedSetting) []string {
	out := make([]string, 0, len(s))
	for _, x := range s {
		out = append(out, x.Name)
	}
	return out
}
