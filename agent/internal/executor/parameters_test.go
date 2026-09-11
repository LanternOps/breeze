package executor

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestParametersFromPayload(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want map[string]string
	}{
		{name: "absent", raw: nil, want: nil},
		{name: "wrong type", raw: "GoogleEmail=x", want: nil},
		{name: "empty object", raw: map[string]any{}, want: map[string]string{}},
		{
			name: "strings kept",
			raw:  map[string]any{"GoogleEmail": "user@example.com", "tenant-domain": "example.com"},
			want: map[string]string{"GoogleEmail": "user@example.com", "tenant-domain": "example.com"},
		},
		{
			name: "non-strings dropped, not coerced",
			raw:  map[string]any{"keep": "yes", "retries": float64(3), "flag": true, "nested": map[string]any{"a": "b"}, "null": nil},
			want: map[string]string{"keep": "yes"},
		},
		{
			name: "empty string value is a real value",
			raw:  map[string]any{"optional": ""},
			want: map[string]string{"optional": ""},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ParametersFromPayload(tc.raw)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ParametersFromPayload(%#v) = %#v, want %#v", tc.raw, got, tc.want)
			}
		})
	}
}

// TestParametersFromPayloadMatchesJSONRoundTrip proves the decoder handles the
// shape it actually sees on the runAs=user path: a payload that has been
// marshalled to JSON by the daemon and unmarshalled by the helper, where every
// number has become float64 and nothing carries Go type information.
func TestParametersFromPayloadMatchesJSONRoundTrip(t *testing.T) {
	wire, err := json.Marshal(map[string]any{
		"parameters": map[string]any{"GoogleEmail": "user@example.com", "retries": 3},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(wire, &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	got := ParametersFromPayload(payload["parameters"])
	want := map[string]string{"GoogleEmail": "user@example.com"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after a JSON round trip got %#v, want %#v", got, want)
	}
}

// captureExecutorLog swaps the package logger for the duration of a test and
// returns a reader for the records it emitted. Safe because no test in this
// package calls t.Parallel(), and the swap is restored on cleanup.
//
// JSON rather than text so a test can assert on the ATTRIBUTE SET, not just on
// substrings. That distinction matters here: the guarantee under test is that
// a parameter VALUE never reaches the log, and a substring check for a short
// value like "3" would match the timestamp instead of proving anything.
func captureExecutorLog(t *testing.T) func() []map[string]any {
	t.Helper()
	var buf bytes.Buffer
	prev := log
	log = slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	t.Cleanup(func() { log = prev })

	return func() []map[string]any {
		t.Helper()
		var records []map[string]any
		for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
			if line == "" {
				continue
			}
			var rec map[string]any
			if err := json.Unmarshal([]byte(line), &rec); err != nil {
				t.Fatalf("log line is not JSON (%v): %s", err, line)
			}
			records = append(records, rec)
		}
		return records
	}
}

// attrNames returns a record's attribute names, sorted, so a test can pin the
// exact shape of a log line. Adding an attribute that carries a value would
// change this set and redden the assertion.
//
// The expected sets below are slog's own three (time/level/msg) plus whatever
// the call site adds. They deliberately omit the `component=executor`
// attribute the real package logger carries: captureExecutorLog installs a
// bare handler, and the guarantee under test is about what
// ParametersFromPayload itself attaches, not about the logger's own framing.
func attrNames(rec map[string]any) []string {
	names := make([]string, 0, len(rec))
	for k := range rec {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}

// onlyRecord asserts exactly one log record was emitted and returns it.
func onlyRecord(t *testing.T, read func() []map[string]any) map[string]any {
	t.Helper()
	records := read()
	if len(records) != 1 {
		t.Fatalf("expected exactly one log record, got %d: %#v", len(records), records)
	}
	return records[0]
}

// TestParametersFromPayloadWarnsOnBrokenWireContract proves the diagnostic
// actually fires. #4882 was invisible precisely because a dropped parameter
// produced no agent-side signal at all — a tripwire that silently does not
// trip would reproduce that, so assert it rather than assume it.
func TestParametersFromPayloadWarnsOnBrokenWireContract(t *testing.T) {
	t.Run("non-object parameters field", func(t *testing.T) {
		read := captureExecutorLog(t)
		if got := ParametersFromPayload("GoogleEmail=user@example.com"); got != nil {
			t.Fatalf("got %#v, want nil", got)
		}
		rec := onlyRecord(t, read)
		if !strings.Contains(rec["msg"].(string), "non-object") {
			t.Fatalf("expected a warning about the non-object payload, got %#v", rec)
		}
		if rec["payloadType"] != "string" {
			t.Errorf("payloadType = %#v, want the offending Go type", rec["payloadType"])
		}
		// Pinning the attribute set is the actual content guarantee: the
		// offending payload was itself operator data, and nothing here may
		// carry it. A new attribute holding the value would change this set.
		if got, want := attrNames(rec), []string{"level", "msg", "payloadType", "time"}; !reflect.DeepEqual(got, want) {
			t.Errorf("log attributes = %v, want exactly %v — an added attribute may be leaking payload content", got, want)
		}
	})

	t.Run("absent parameters field stays silent", func(t *testing.T) {
		read := captureExecutorLog(t)
		if got := ParametersFromPayload(nil); got != nil {
			t.Fatalf("got %#v, want nil", got)
		}
		if records := read(); len(records) != 0 {
			t.Fatalf("an unparameterised script must log nothing, got %#v", records)
		}
	})

	t.Run("dropped non-string values name their keys and never their values", func(t *testing.T) {
		read := captureExecutorLog(t)
		got := ParametersFromPayload(map[string]any{
			"keep":    "yes",
			"retries": float64(3),
			"flag":    true,
		})
		if !reflect.DeepEqual(got, map[string]string{"keep": "yes"}) {
			t.Fatalf("got %#v", got)
		}

		rec := onlyRecord(t, read)
		if rec["keys"] != "flag,retries" {
			t.Fatalf("keys = %#v, want the dropped keys sorted", rec["keys"])
		}
		// The stated guarantee is keys-only. Assert it structurally rather
		// than by substring: a dropped value like 3 or true is far too short
		// to search for in a rendered line without matching the timestamp or
		// the level, so pin the attribute set instead. A mutation that added
		// `"values", "3,true"` would satisfy every other assertion here and
		// only this one catches it.
		if got, want := attrNames(rec), []string{"keys", "level", "msg", "time"}; !reflect.DeepEqual(got, want) {
			t.Errorf("log attributes = %v, want exactly %v — a value-bearing attribute must never be added", got, want)
		}
		if strings.Contains(rec["keys"].(string), "keep") {
			t.Errorf("a kept key must not be reported as dropped, got %#v", rec["keys"])
		}
	})

	t.Run("all-string map stays silent", func(t *testing.T) {
		read := captureExecutorLog(t)
		ParametersFromPayload(map[string]any{"GoogleEmail": "user@example.com"})
		if records := read(); len(records) != 0 {
			t.Fatalf("the ordinary case must log nothing, got %#v", records)
		}
	})
}
