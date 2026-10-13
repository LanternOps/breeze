package heartbeat

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

func stubLogShippingSnapshot(t *testing.T, snap logging.HealthSnapshot) {
	t.Helper()
	prev := logShippingSnapshot
	logShippingSnapshot = func() logging.HealthSnapshot { return snap }
	t.Cleanup(func() { logShippingSnapshot = prev })
}

func failingSnapshot() logging.HealthSnapshot {
	ok := false
	return logging.HealthSnapshot{
		Initialized:   true,
		LastAttemptAt: time.Date(2026, 10, 12, 10, 0, 0, 0, time.FixedZone("x", -6*3600)),
		LastSuccessAt: time.Date(2026, 10, 12, 9, 59, 0, 0, time.FixedZone("x", -6*3600)),
		LastAttemptOk: &ok,
		LastError:     "http 503",
		QueueDepth:    412,
		Dropped:       7,
	}
}

func marshalLogShipping(t *testing.T, p *HeartbeatPayload) map[string]any {
	t.Helper()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// apiLogShippingKeys pins the shape the merged API strict-parses
// (apps/api/src/services/logShippingHealth.ts `reportSchema`, #8608):
// schemaVersion literal 1, queueDepth int 0..1e6 and droppedLogs int 0..1e9
// required; lastAttemptAt/lastSuccessAt ISO datetimes, lastAttemptOk boolean
// and lastError string <=160 optional (absent, never null). A mismatch makes
// the API classify the beat `invalid` and silently change nothing.
var apiLogShippingKeys = map[string]string{
	"schemaVersion": "number",
	"lastAttemptAt": "datetime",
	"lastSuccessAt": "datetime",
	"lastAttemptOk": "bool",
	"lastError":     "string",
	"queueDepth":    "number",
	"droppedLogs":   "number",
}

func assertMatchesAPIShape(t *testing.T, obj map[string]any) {
	t.Helper()
	for _, req := range []string{"schemaVersion", "queueDepth", "droppedLogs"} {
		if _, ok := obj[req]; !ok {
			t.Fatalf("required key %q missing: %v", req, obj)
		}
	}
	if obj["schemaVersion"] != float64(1) {
		t.Fatalf("schemaVersion = %v, want 1", obj["schemaVersion"])
	}
	for k, v := range obj {
		kind, ok := apiLogShippingKeys[k]
		if !ok {
			t.Fatalf("unexpected key %q (API strips it; keep the wire shape exact)", k)
		}
		switch kind {
		case "number":
			f, isNum := v.(float64)
			if !isNum || f < 0 || f != float64(int64(f)) {
				t.Fatalf("%s = %v (%T), want a non-negative integer", k, v, v)
			}
		case "bool":
			if _, isBool := v.(bool); !isBool {
				t.Fatalf("%s = %v (%T), want bool (absent, never null)", k, v, v)
			}
		case "string":
			s, isStr := v.(string)
			if !isStr || len(s) > 160 {
				t.Fatalf("%s = %v, want string <=160", k, v)
			}
		case "datetime":
			s, isStr := v.(string)
			if !isStr || !strings.HasSuffix(s, "Z") {
				t.Fatalf("%s = %v, want RFC3339 UTC", k, v)
			}
			if _, err := time.Parse(time.RFC3339, s); err != nil {
				t.Fatalf("%s = %q not RFC3339: %v", k, s, err)
			}
		}
	}
	if q := obj["queueDepth"].(float64); q > 1e6 {
		t.Fatalf("queueDepth %v above API max", q)
	}
	if d := obj["droppedLogs"].(float64); d > 1e9 {
		t.Fatalf("droppedLogs %v above API max", d)
	}
}

// (a) no shipper → key absent: unknown, never healthy.
func TestLogShipPayload_UninitializedIsAbsent(t *testing.T) {
	stubLogShippingSnapshot(t, logging.HealthSnapshot{})
	var p HeartbeatPayload
	attachLogShipping(&p)
	m := marshalLogShipping(t, &p)
	if _, ok := m["logShipping"]; ok {
		t.Fatalf("logShipping present without a shipper: %v", m["logShipping"])
	}
	if _, ok := m["droppedLogs"]; ok {
		t.Fatalf("top-level droppedLogs present without a shipper")
	}
}

// (b) initialized, nothing attempted → zeros, no timestamps, no outcome (quiet).
func TestLogShipPayload_QuietHasZerosAndNoTimestamps(t *testing.T) {
	stubLogShippingSnapshot(t, logging.HealthSnapshot{Initialized: true})
	var p HeartbeatPayload
	attachLogShipping(&p)
	obj, ok := marshalLogShipping(t, &p)["logShipping"].(map[string]any)
	if !ok {
		t.Fatal("logShipping missing for an initialized shipper")
	}
	assertMatchesAPIShape(t, obj)
	if len(obj) != 3 || obj["queueDepth"] != float64(0) || obj["droppedLogs"] != float64(0) {
		t.Fatalf("quiet object = %v, want exactly schemaVersion/queueDepth/droppedLogs with zeros", obj)
	}
}

func TestLogShipPayload_OkOutcome(t *testing.T) {
	ok := true
	at := time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)
	stubLogShippingSnapshot(t, logging.HealthSnapshot{Initialized: true, LastAttemptAt: at, LastSuccessAt: at, LastAttemptOk: &ok})
	var p HeartbeatPayload
	attachLogShipping(&p)
	obj := marshalLogShipping(t, &p)["logShipping"].(map[string]any)
	assertMatchesAPIShape(t, obj)
	if obj["lastAttemptOk"] != true {
		t.Fatalf("lastAttemptOk = %v", obj["lastAttemptOk"])
	}
	if _, has := obj["lastError"]; has {
		t.Fatal("lastError present on a successful outcome")
	}
}

// (c) failing → RFC3339 UTC timestamps, explicit false, bounded error.
func TestLogShipPayload_FailingFields(t *testing.T) {
	stubLogShippingSnapshot(t, failingSnapshot())
	var p HeartbeatPayload
	attachLogShipping(&p)
	obj := marshalLogShipping(t, &p)["logShipping"].(map[string]any)
	assertMatchesAPIShape(t, obj)
	if obj["lastAttemptOk"] != false || obj["lastError"] != "http 503" {
		t.Fatalf("failing outcome wrong: %v", obj)
	}
	if obj["lastAttemptAt"] != "2026-10-12T16:00:00Z" || obj["lastSuccessAt"] != "2026-10-12T15:59:00Z" {
		t.Fatalf("timestamps not normalised to UTC: %v / %v", obj["lastAttemptAt"], obj["lastSuccessAt"])
	}
	if obj["queueDepth"] != float64(412) {
		t.Fatalf("queueDepth = %v", obj["queueDepth"])
	}
}

// (d) the top-level droppedLogs (kept one more release) equals the nested one.
func TestLogShipPayload_TopLevelDroppedMatchesNested(t *testing.T) {
	stubLogShippingSnapshot(t, failingSnapshot())
	var p HeartbeatPayload
	attachLogShipping(&p)
	m := marshalLogShipping(t, &p)
	nested := m["logShipping"].(map[string]any)["droppedLogs"]
	if m["droppedLogs"] != float64(7) || nested != float64(7) {
		t.Fatalf("top-level %v / nested %v, want 7 / 7", m["droppedLogs"], nested)
	}
}

func TestLogShipPayload_ClampsToAPIBounds(t *testing.T) {
	snap := failingSnapshot()
	snap.QueueDepth = 5_000_000
	snap.Dropped = 9_000_000_000
	snap.LastError = strings.Repeat("x", 500)
	stubLogShippingSnapshot(t, snap)
	var p HeartbeatPayload
	attachLogShipping(&p)
	obj := marshalLogShipping(t, &p)["logShipping"].(map[string]any)
	assertMatchesAPIShape(t, obj)
	if p.DroppedLogs != 9_000_000_000 {
		t.Fatalf("top-level droppedLogs must stay unclamped, got %d", p.DroppedLogs)
	}
}

// (e) the worst-case object adds at most 400 bytes to the beat.
func TestLogShipPayload_SizeDeltaBounded(t *testing.T) {
	base, _ := json.Marshal(&HeartbeatPayload{Status: "ok"})
	snap := failingSnapshot()
	snap.QueueDepth = 1_000_000
	snap.Dropped = 1_000_000_000
	snap.LastError = strings.Repeat("x", 160)
	stubLogShippingSnapshot(t, snap)
	p := HeartbeatPayload{Status: "ok"}
	attachLogShipping(&p)
	with, _ := json.Marshal(&p)
	if delta := len(with) - len(base); delta > 400 {
		t.Fatalf("logShipping adds %d bytes, want <= 400", delta)
	}
}

// (f) CommitDroppedLogCount runs only after a successful beat, and the
// droppedLogs the server received (top-level and nested) is the pre-commit
// value either way.
func TestLogShipPayload_CommitDroppedOnlyAfterSuccessfulBeat(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		wantCommit int
	}{
		{"200", http.StatusOK, 1},
		{"500", http.StatusInternalServerError, 0},
		{"401", http.StatusUnauthorized, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var received []byte
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				received, _ = io.ReadAll(r.Body)
				w.WriteHeader(tc.status)
				if tc.status == http.StatusOK {
					_, _ = w.Write([]byte(`{}`))
				}
			}))
			defer srv.Close()

			stubLogShippingSnapshot(t, failingSnapshot())
			commits := 0
			prevCommit := commitDroppedLogCount
			commitDroppedLogCount = func() { commits++ }
			t.Cleanup(func() { commitDroppedLogCount = prevCommit })

			h := newRecoveryMarkerTestHeartbeat(&config.Config{AgentID: "agent-1", ServerURL: srv.URL, AuthToken: "t"})
			p := HeartbeatPayload{Status: "ok"}
			attachLogShipping(&p)
			_, ok := h.doHeartbeatPost(srv.URL, &p)
			if ok != (tc.status == http.StatusOK) {
				t.Fatalf("doHeartbeatPost ok = %v for %d", ok, tc.status)
			}
			if commits != tc.wantCommit {
				t.Fatalf("CommitDroppedLogCount called %d times, want %d", commits, tc.wantCommit)
			}
			var body map[string]any
			if err := json.Unmarshal(received, &body); err != nil {
				t.Fatalf("server body not JSON: %v", err)
			}
			nested := body["logShipping"].(map[string]any)["droppedLogs"]
			if body["droppedLogs"] != float64(7) || nested != float64(7) {
				t.Fatalf("server saw droppedLogs %v / nested %v, want pre-commit 7 / 7", body["droppedLogs"], nested)
			}
		})
	}
}
