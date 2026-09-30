package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
)

type fakeTimeManager struct {
	mu       sync.Mutex
	applied  []any
	cycles   int
	commands []string
	payload  map[string]any
	result   any
	err      error
	cycle    func(context.Context) error
	// apply overrides Apply's (changed, err) answer when set.
	apply func(any) (bool, error)
}

func (f *fakeTimeManager) Apply(raw any) (bool, error) {
	f.mu.Lock()
	f.applied = append(f.applied, raw)
	fn := f.apply
	err := f.err
	f.mu.Unlock()
	if fn != nil {
		return fn(raw)
	}
	return true, err
}
func (f *fakeTimeManager) Cycle(ctx context.Context) error {
	f.mu.Lock()
	f.cycles++
	fn := f.cycle
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx)
	}
	return nil
}
func (f *fakeTimeManager) Command(_ context.Context, kind string, p map[string]any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commands = append(f.commands, kind)
	f.payload = p
	return f.result, f.err
}
func newTimeHeartbeat(f *fakeTimeManager) *Heartbeat {
	ctx, cancel := context.WithCancel(context.Background())
	return &Heartbeat{config: &config.Config{AgentID: "fixture-agent"}, timeSync: &timeSyncRuntime{
		manager: f, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1)}}
}
func TestTimeSettingsDispatchBeforeProbeReturn(t *testing.T) {
	for _, key := range []string{"time_sync_settings", "timeSyncSettings"} {
		f := &fakeTimeManager{}
		h := newTimeHeartbeat(f)
		// No policy_registry_state_probes or policy_config_state_probes keys.
		h.applyConfigUpdate(map[string]any{key: map[string]any{"fingerprint": "fixture"}})
		if !h.timeSync.hasPending || len(h.timeSync.wake) != 1 {
			t.Fatalf("%s dispatch lost", key)
		}
		h.applyConfigUpdate(map[string]any{"unrelated": true})
		if !h.timeSync.hasPending {
			t.Fatal("omitted settings cleared policy")
		}
		if len(f.applied) != 0 {
			t.Fatal("heartbeat response blocked on management execution")
		}
		h.stopTimeSync()
	}
}
func TestTimeSettingsImmediateCycleAndCancellation(t *testing.T) {
	entered := make(chan struct{})
	f := &fakeTimeManager{cycle: func(ctx context.Context) error { close(entered); <-ctx.Done(); return ctx.Err() }}
	h := newTimeHeartbeat(f)
	h.startTimeSync()
	h.applyTimeSyncSettings(map[string]any{"fingerprint": "fixture"})
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("settings did not trigger immediate collection")
	}
	h.stopTimeSync()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("time collection not cancelled/tracked")
	}
	h.applyTimeSyncSettings(map[string]any{})
	if len(f.applied) != 1 || h.timeSync.hasPending {
		t.Fatal("settings accepted after shutdown")
	}
}
func TestTimeCadenceAndNoDuplicateStart(t *testing.T) {
	for i := 0; i < 100; i++ {
		id := string(rune(i))
		d := timeSyncFirstDelay(id)
		if d < 2*time.Minute || d > 5*time.Minute {
			t.Fatal(d)
		}
		d = timeSyncInterval(id, time.Unix(int64(i), 0))
		if d < 27*time.Minute || d > 33*time.Minute {
			t.Fatal(d)
		}
	}
	f := &fakeTimeManager{}
	h := newTimeHeartbeat(f)
	now := time.Now()
	h.mu.Lock()
	h.timeSync.started = true
	h.timeSync.lastTimeSyncUpdate = now
	h.timeSyncTickLocked(now.Add(26 * time.Minute))
	if len(h.timeSync.wake) != 0 {
		t.Fatal("early tick")
	}
	h.timeSyncTickLocked(now.Add(timeSyncInterval(h.config.AgentID, now)))
	if len(h.timeSync.wake) != 0 {
		t.Fatal("strict boundary changed")
	}
	h.timeSyncTickLocked(now.Add(34 * time.Minute))
	if len(h.timeSync.wake) != 1 {
		t.Fatal("due tick lost")
	}
	h.timeSyncTickLocked(now.Add(34 * time.Minute))
	if len(h.timeSync.wake) != 1 {
		t.Fatal("duplicate tick")
	}
	h.mu.Unlock()
	h.stopTimeSync()
}
func TestInvalidTimeSettingsStillWakeSnapshot(t *testing.T) {
	f := &fakeTimeManager{err: errors.New("invalid_settings")}
	h := newTimeHeartbeat(f)
	h.applyTimeSyncSettings(map[string]any{"ntp_servers": []string{"bad;host"}})
	if len(h.timeSync.wake) != 1 {
		t.Fatal("rejection was not scheduled for reporting")
	}
	h.stopTimeSync()
}

// Apply answers changed=false for a repeated identical delivery, a repeated
// rejection and a repeated persistence failure. The API re-sends settings on
// every heartbeat, so none of those may run a cycle (an upload plus a fresh
// enforcement audit row) per heartbeat; only a change or a due tick may.
func TestUnchangedTimeSettingsDoNotCycleEveryHeartbeat(t *testing.T) {
	type answer struct {
		changed bool
		err     error
	}
	answers := make(chan answer, 1)
	// Buffered past any regression so a stray cycle or apply never blocks the
	// worker: a broken dispatcher must red on the count, not hang the suite.
	applied := make(chan struct{}, 64)
	entered := make(chan struct{}, 64)
	f := &fakeTimeManager{
		apply: func(any) (bool, error) {
			a := <-answers // A closed channel (teardown) answers unchanged.
			applied <- struct{}{}
			return a.changed, a.err
		},
		cycle: func(context.Context) error { entered <- struct{}{}; return nil },
	}
	h := newTimeHeartbeat(f)
	defer func() { h.stopTimeSync(); h.inventoryWg.Wait() }()
	defer close(answers)
	h.mu.Lock()
	h.timeSync.lastTimeSyncUpdate = time.Now()
	h.mu.Unlock()
	h.startTimeSync()
	deliver := func(a answer) {
		t.Helper()
		answers <- a
		h.applyTimeSyncSettings(map[string]any{"fingerprint": "fixture"})
		select {
		case <-applied:
		case <-time.After(time.Second):
			t.Fatal("delivery not applied")
		}
	}
	for i := 0; i < 5; i++ {
		deliver(answer{false, errors.New("settings still not persisted")})
		deliver(answer{false, nil})
	}
	// The worker is sequential: any cycle caused by an unchanged delivery would
	// have run before the changed delivery's cycle below.
	deliver(answer{true, nil})
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("changed settings did not cycle")
	}
	// A due schedule still reconciles even when the delivery changed nothing.
	h.mu.Lock()
	h.timeSync.lastTimeSyncUpdate = time.Now().Add(-time.Hour)
	h.mu.Unlock()
	deliver(answer{false, errors.New("settings still not persisted")})
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("due cycle suppressed by an unchanged delivery")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cycles != 2 {
		t.Fatal("unchanged deliveries ran cycles", f.cycles)
	}
}
func TestTimeUploadWireAndCancellation(t *testing.T) {
	f := &fakeTimeManager{}
	h := newTimeHeartbeat(f)
	h.retryCfg.MaxRetries = 0
	var calls atomic.Int32
	entered := make(chan struct{})
	h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Method != "PUT" || r.URL.Path != "/api/v1/agents/fixture-agent/time-status" {
			t.Error(r.Method, r.URL)
		}
		b, e := io.ReadAll(r.Body)
		if e != nil {
			t.Error(e)
		}
		var body map[string]any
		if e = json.Unmarshal(b, &body); e != nil {
			t.Error(e)
		}
		if len(body) != 2 || body["sequence"] != float64(3) || !strings.Contains(string(b), `"enforcement"`) {
			t.Error(string(b))
		}
		close(entered)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	// config.ServerURL is used by serverURL(); no real network request is made.
	h.config.ServerURL = "https://api.example.com"
	ctx, cancel := context.WithCancel(h.timeSync.ctx)
	done := make(chan error, 1)
	go func() {
		done <- h.sendInventoryData("time-status", timeSyncUpload{ctx: ctx, data: map[string]any{"sequence": 3, "enforcement": nil}}, "time sync")
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("upload not dispatched")
	}
	cancel()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("cancelled upload succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("upload lost command context")
	}
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
	h.stopTimeSync()
}
func TestTimeSyncQualifiedTransport(t *testing.T) {
	cases := []struct {
		name   string
		code   int
		body   string
		commit bool
	}{
		{"accepted", 200, `{"accepted":true}`, true},
		{"other 2xx accepted", 201, `{"accepted":true}`, true},
		{"stale sequence", 200, `{"accepted":false,"reason":"stale_sequence"}`, true},
		{"false without reason", 200, `{"accepted":false}`, false},
		{"other reason", 200, `{"accepted":false,"reason":"disabled"}`, false},
		{"missing accepted", 200, `{"reason":"stale_sequence"}`, false},
		{"null accepted", 200, `{"accepted":null,"reason":"stale_sequence"}`, false},
		{"wrong type", 200, `{"accepted":"true"}`, false},
		{"malformed", 200, `{`, false},
		{"trailing JSON", 200, `{"accepted":true}{}`, false},
		{"empty response", 204, "", false},
	}
	for _, code := range []int{400, 401, 403, 413, 422, 429, 503} {
		cases = append(cases, struct {
			name   string
			code   int
			body   string
			commit bool
		}{fmt.Sprint(code), code, `{"accepted":true}`, false})
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newTimeHeartbeat(&fakeTimeManager{})
			defer h.stopTimeSync()
			h.config.ServerURL = "https://time.example.com"
			h.config.AuthToken = "fixture-token"
			h.retryCfg.MaxRetries = 0
			var calls atomic.Int32
			h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if r.Method != "PUT" || r.URL.Path != "/api/v1/agents/fixture-agent/time-status" || r.Header.Get("Authorization") != "Bearer fixture-token" {
					t.Error(r.Method, r.URL, r.Header)
				}
				var sent map[string]json.RawMessage
				if e := json.NewDecoder(r.Body).Decode(&sent); e != nil {
					t.Error(e)
				}
				if string(sent["sequence"]) != "7" || string(sent["enforcement"]) != "null" {
					t.Error(sent)
				}
				return &http.Response{StatusCode: tc.code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			e := h.sendInventoryData("time-status", timeSyncUpload{ctx: h.timeSync.ctx, data: map[string]any{"sequence": 7, "enforcement": nil}}, "time sync")
			if (e == nil) != tc.commit || calls.Load() != 1 {
				t.Fatal("qualified-success contract", e, calls.Load())
			}
		})
	}
}
func TestTimeSyncTransportFailureAndOtherInventory(t *testing.T) {
	h := newTimeHeartbeat(&fakeTimeManager{})
	defer h.stopTimeSync()
	h.config.ServerURL = "https://time.example.com"
	h.retryCfg.MaxRetries = 0
	h.client = &http.Client{Transport: hardwareTransport(func(*http.Request) (*http.Response, error) { return nil, errors.New("connection lost") })}
	if e := h.sendInventoryData("time-status", timeSyncUpload{ctx: h.timeSync.ctx, data: map[string]any{}}, "time sync"); e == nil {
		t.Fatal("transport failure hidden")
	}
	h.client = &http.Client{Transport: hardwareTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	if e := h.sendInventoryData("hardware-health", map[string]string{}, "hardware health"); e != nil {
		t.Fatal(e)
	}
	if e := validateTimeSyncResponse(strings.NewReader(strings.Repeat("x", 64*1024+1))); e == nil {
		t.Fatal("unbounded response")
	}
}
func TestTimeSyncStartupTimerDrains(t *testing.T) {
	f := &fakeTimeManager{cycle: func(context.Context) error { t.Error("timer fired immediately"); return nil }}
	h := newTimeHeartbeat(f)
	h.startTimeSync()
	h.startTimeSync()
	h.stopTimeSync()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("startup worker not tracked")
	}
	h.startTimeSync()
	if !h.timeSync.stopping {
		t.Fatal("stopped runtime restarted")
	}
}
func TestTimeSyncSingleWorkerAndPanicRecovery(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	f := &fakeTimeManager{cycle: func(context.Context) error { close(entered); <-release; panic("fixture panic") }}
	h := newTimeHeartbeat(f)
	h.startTimeSync()
	h.startTimeSync()
	h.mu.Lock()
	h.wakeTimeSyncLocked()
	h.mu.Unlock()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	h.mu.Lock()
	h.timeSyncTickLocked(time.Now().Add(time.Hour))
	queued := len(h.timeSync.wake)
	h.mu.Unlock()
	if queued != 0 {
		t.Fatal("tick queued duplicate while running")
	}
	close(release)
	// Wait for the guarded cycle to return without racing scheduler state.
	go func() {
		defer close(finished)
		deadline := time.NewTimer(time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-deadline.C:
				return
			case <-ticker.C:
				h.mu.Lock()
				running := h.timeSync.running
				h.mu.Unlock()
				if !running {
					return
				}
			}
		}
	}()
	<-finished
	h.mu.Lock()
	running := h.timeSync.running
	h.mu.Unlock()
	h.stopTimeSync()
	h.inventoryWg.Wait()
	if running {
		t.Fatal("panic stranded running state")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cycles != 1 {
		t.Fatal("duplicate worker", f.cycles)
	}
}
func TestTimeSyncGuardHandlesNilCollection(t *testing.T) {
	// Manager's nil-snapshot test covers no send/commit; keep the outer guard's
	// panic-to-error behavior explicit at the heartbeat boundary as well.
	_, e := collectors.Guard("timesync.management", func() (bool, error) { panic("fixture panic") })
	if e == nil {
		t.Fatal("collector guard hid panic")
	}
}
