package executor

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"reflect"
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
// returns the buffer it writes to. Safe because no test in this package calls
// t.Parallel(), and the swap is restored on cleanup.
func captureExecutorLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := log
	log = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	t.Cleanup(func() { log = prev })
	return &buf
}

// TestParametersFromPayloadWarnsOnBrokenWireContract proves the diagnostic
// actually fires. #4882 was invisible precisely because a dropped parameter
// produced no agent-side signal at all — a tripwire that silently does not
// trip would reproduce that, so assert it rather than assume it.
func TestParametersFromPayloadWarnsOnBrokenWireContract(t *testing.T) {
	t.Run("non-object parameters field", func(t *testing.T) {
		buf := captureExecutorLog(t)
		if got := ParametersFromPayload("GoogleEmail=x"); got != nil {
			t.Fatalf("got %#v, want nil", got)
		}
		out := buf.String()
		if !strings.Contains(out, "non-object") {
			t.Fatalf("expected a warning about the non-object payload, got %q", out)
		}
		if !strings.Contains(out, "payloadType=string") {
			t.Errorf("warning should name the offending type, got %q", out)
		}
	})

	t.Run("absent parameters field stays silent", func(t *testing.T) {
		buf := captureExecutorLog(t)
		if got := ParametersFromPayload(nil); got != nil {
			t.Fatalf("got %#v, want nil", got)
		}
		if out := buf.String(); out != "" {
			t.Fatalf("an unparameterised script must log nothing, got %q", out)
		}
	})

	t.Run("dropped non-string values name their keys only", func(t *testing.T) {
		buf := captureExecutorLog(t)
		got := ParametersFromPayload(map[string]any{
			"keep":    "yes",
			"retries": float64(3),
			"flag":    true,
		})
		if !reflect.DeepEqual(got, map[string]string{"keep": "yes"}) {
			t.Fatalf("got %#v", got)
		}
		out := buf.String()
		if !strings.Contains(out, "keys=flag,retries") {
			t.Fatalf("expected the dropped keys, sorted, got %q", out)
		}
		if strings.Contains(out, "keep") {
			t.Errorf("a kept key must not be reported as dropped, got %q", out)
		}
	})

	t.Run("all-string map stays silent", func(t *testing.T) {
		buf := captureExecutorLog(t)
		ParametersFromPayload(map[string]any{"GoogleEmail": "user@example.com"})
		if out := buf.String(); out != "" {
			t.Fatalf("the ordinary case must log nothing, got %q", out)
		}
	})
}
