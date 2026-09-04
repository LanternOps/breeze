package executor

import (
	"encoding/json"
	"reflect"
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
