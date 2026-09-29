package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/timesync"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

type timeCollectorFake struct {
	collect           func(context.Context) (*timesync.Snapshot, error)
	committed         atomic.Uint64
	commitErr         error
	committedSnapshot *timesync.Snapshot
}

func (f *timeCollectorFake) Collect(ctx context.Context) (*timesync.Snapshot, error) {
	return f.collect(ctx)
}
func (f *timeCollectorFake) Commit(snapshot *timesync.Snapshot) error {
	if f.commitErr != nil {
		return f.commitErr
	}
	f.committedSnapshot = snapshot
	f.committed.Store(snapshot.Sequence)
	return nil
}
func timeHeartbeat(t *testing.T, f *timeCollectorFake) *Heartbeat {
	t.Helper()
	cfg := config.Default()
	cfg.AgentID = "fixture-agent"
	cfg.ServerURL = "https://time.example.com"
	cfg.AuthToken = "fixture-token"
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &Heartbeat{config: cfg, timeSyncCol: f, timeSyncContext: ctx, timeSyncCancel: cancel, retryCfg: httputil.DefaultRetryConfig()}
}
func TestTimeSyncScheduleAndSingleFlight(t *testing.T) {
	last := time.Unix(1000, 0)
	for i := 0; i < 100; i++ {
		id := string(rune(i))
		d := timeSyncFirstDelay(id)
		if d < 2*time.Minute || d > 5*time.Minute {
			t.Fatal(d)
		}
		interval := timeSyncInterval(id, last)
		if interval < 27*time.Minute || interval > 33*time.Minute {
			t.Fatal(interval)
		}
	}
	h := timeHeartbeat(t, &timeCollectorFake{})
	if h.timeSyncDueLocked(last, false) {
		t.Fatal("ran before delayed first run")
	}
	if !h.timeSyncDueLocked(last, true) {
		t.Fatal("first cycle not claimed")
	}
	if h.timeSyncDueLocked(last.Add(time.Hour), false) {
		t.Fatal("overlapping cycle claimed")
	}
	h.timeSyncRunning = false
	due := last.Add(timeSyncInterval(h.config.AgentID, last))
	if h.timeSyncDueLocked(due, false) {
		t.Fatal("strict gate boundary changed")
	}
	if !h.timeSyncDueLocked(due.Add(time.Nanosecond), false) {
		t.Fatal("due cycle missed")
	}
	h.timeSyncRunning = false
	h.stopTimeSync()
	if h.timeSyncDueLocked(due.Add(time.Hour), true) {
		t.Fatal("stopped collector restarted")
	}
}
func TestTimeSyncPUTAndQualifiedCommit(t *testing.T) {
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
			snapshot := &timesync.Snapshot{SchemaVersion: 1, Sequence: 7, CollectedAt: time.Unix(100, 0).UTC()}
			f := &timeCollectorFake{collect: func(context.Context) (*timesync.Snapshot, error) { return snapshot, nil }}
			h := timeHeartbeat(t, f)
			h.retryCfg.MaxRetries = 0
			var calls atomic.Int32
			h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if r.Method != "PUT" || r.URL.Path != "/api/v1/agents/fixture-agent/time-status" || r.Header.Get("Authorization") != "Bearer fixture-token" {
					t.Error(r.Method, r.URL, r.Header)
				}
				var sent map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
					t.Error(err)
				}
				if string(sent["enforcement"]) != "null" || string(sent["sequence"]) != "7" {
					t.Error(sent)
				}
				return &http.Response{StatusCode: tc.code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			h.timeSyncRunning = true
			h.dispatchTimeSync()
			h.inventoryWg.Wait()
			if calls.Load() != 1 {
				t.Fatal("unexpected request count", calls.Load())
			}
			if tc.commit {
				if f.committed.Load() != 7 || f.committedSnapshot != snapshot {
					t.Fatal("qualified delivery did not commit exact snapshot")
				}
			} else if f.committed.Load() != 0 {
				t.Fatal("unqualified delivery committed")
			}
			if h.timeSyncRunning {
				t.Fatal("running gate stranded")
			}
		})
	}
}

func TestTimeSyncTransportAndCommitFailures(t *testing.T) {
	for _, phase := range []string{"transport", "commit"} {
		t.Run(phase, func(t *testing.T) {
			f := &timeCollectorFake{collect: func(context.Context) (*timesync.Snapshot, error) {
				return &timesync.Snapshot{SchemaVersion: 1, Sequence: 7}, nil
			}}
			if phase == "commit" {
				f.commitErr = errors.New("disk full")
			}
			h := timeHeartbeat(t, f)
			h.retryCfg.MaxRetries = 0
			h.client = &http.Client{Transport: hardwareTransport(func(*http.Request) (*http.Response, error) {
				if phase == "transport" {
					return nil, errors.New("connection lost")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"accepted":true}`))}, nil
			})}
			h.timeSyncRunning = true
			h.dispatchTimeSync()
			h.inventoryWg.Wait()
			if f.committed.Load() != 0 || h.timeSyncRunning {
				t.Fatal("failure committed or stranded gate")
			}
		})
	}
}

func TestTimeSyncResponseValidationDoesNotChangeOtherInventory(t *testing.T) {
	h := timeHeartbeat(t, &timeCollectorFake{})
	h.client = &http.Client{Transport: hardwareTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	if err := h.sendInventoryData("hardware-health", map[string]string{}, "hardware health"); err != nil {
		t.Fatal(err)
	}
}

func TestTimeSyncCollectionAndUploadCancellation(t *testing.T) {
	for _, phase := range []string{"collect", "upload"} {
		t.Run(phase, func(t *testing.T) {
			entered := make(chan struct{})
			f := &timeCollectorFake{collect: func(ctx context.Context) (*timesync.Snapshot, error) {
				if phase == "collect" {
					close(entered)
					<-ctx.Done()
					return nil, ctx.Err()
				}
				return &timesync.Snapshot{SchemaVersion: 1, Sequence: 1}, nil
			}}
			h := timeHeartbeat(t, f)
			h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
				close(entered)
				<-r.Context().Done()
				return nil, r.Context().Err()
			})}
			h.timeSyncRunning = true
			h.dispatchTimeSync()
			<-entered
			h.stopTimeSync()
			done := make(chan struct{})
			go func() { h.inventoryWg.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("uncancelled cycle")
			}
			if f.committed.Load() != 0 {
				t.Fatal("cancelled send committed")
			}
		})
	}
}
func TestTimeSyncPanicAndNilDoNotSend(t *testing.T) {
	for _, panicNow := range []bool{false, true} {
		f := &timeCollectorFake{collect: func(context.Context) (*timesync.Snapshot, error) {
			if panicNow {
				panic("fixture panic")
			}
			return nil, nil
		}}
		h := timeHeartbeat(t, f)
		h.client = &http.Client{Transport: hardwareTransport(func(*http.Request) (*http.Response, error) { t.Error("unexpected send"); return nil, context.Canceled })}
		h.timeSyncRunning = true
		h.dispatchTimeSync()
		h.inventoryWg.Wait()
		if h.timeSyncRunning || f.committed.Load() != 0 {
			t.Fatal("guard failed to release gate")
		}
	}
}
func TestTimeSyncStartupTimerDrains(t *testing.T) {
	h := timeHeartbeat(t, &timeCollectorFake{collect: func(context.Context) (*timesync.Snapshot, error) { t.Error("timer fired immediately"); return nil, nil }})
	h.startTimeSync()
	h.stopTimeSync()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("startup timer not tracked")
	}
}
