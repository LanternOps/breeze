package executor

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestParseSecretEnv_Accepts(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want SecretEnv
	}{
		{
			name: "nil payload yields empty SecretEnv",
			raw:  nil,
			want: SecretEnv{},
		},
		{
			name: "empty object yields empty SecretEnv",
			raw:  map[string]any{},
			want: SecretEnv{},
		},
		{
			name: "single valid entry",
			raw:  map[string]any{"api_token": "super-secret-value"},
			want: SecretEnv{"api_token": "super-secret-value"},
		},
		{
			name: "leading underscore key",
			raw:  map[string]any{"_token": "leading-underscore-ok"},
			want: SecretEnv{"_token": "leading-underscore-ok"},
		},
		{
			name: "digits after first char key",
			raw:  map[string]any{"token2": "digits-after-first-ok"},
			want: SecretEnv{"token2": "digits-after-first-ok"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseSecretEnv(tt.raw)
			if err != nil {
				t.Fatalf("ParseSecretEnv(%#v) unexpected error: %v", tt.raw, err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("ParseSecretEnv(%#v) = %d entries, want %d", tt.raw, len(got), len(tt.want))
			}
			for k, v := range tt.want {
				if got[k] != v {
					t.Errorf("ParseSecretEnv(%#v)[%q] = %q, want %q", tt.raw, k, got[k], v)
				}
			}
		})
	}
}

func TestParseSecretEnv_RejectsMalformedShape(t *testing.T) {
	tests := []struct {
		name string
		raw  any
	}{
		{"string instead of object", "nope"},
		{"array instead of object", []any{"a"}},
		{"number instead of object", 42},
		{"non-string value", map[string]any{"api_token": 42}},
		{"empty value", map[string]any{"api_token": ""}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseSecretEnv(tt.raw)
			if err == nil {
				t.Fatalf("ParseSecretEnv(%#v) = nil error, want error", tt.raw)
			}
		})
	}
}

func TestParseSecretEnv_RejectsShortValue_WithoutLeakingIt(t *testing.T) {
	_, err := ParseSecretEnv(map[string]any{"api_token": "ab"})
	if err == nil {
		t.Fatal("ParseSecretEnv with a 2-char value = nil error, want error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "api_token") {
		t.Errorf("error %q does not name the offending key %q", msg, "api_token")
	}
	if strings.Contains(msg, "\"ab\"") {
		t.Errorf("error %q leaks the rejected value", msg)
	}
	if !strings.Contains(msg, "4") {
		t.Errorf("error %q does not mention the length floor (MinSecretValueLength=%d)", msg, MinSecretValueLength)
	}
}

func TestParseSecretEnv_RejectsInvalidKeyGrammar(t *testing.T) {
	badKeys := []string{"BAD KEY", "9lives", "a-b", ""}

	for _, key := range badKeys {
		t.Run(fmt.Sprintf("key=%q", key), func(t *testing.T) {
			_, err := ParseSecretEnv(map[string]any{key: "valid-length-value"})
			if err == nil {
				t.Fatalf("ParseSecretEnv with key %q = nil error, want error", key)
			}
		})
	}
}

func TestParseSecretEnv_RejectsTooManyEntries(t *testing.T) {
	m := make(map[string]any, MaxSecretEnvEntries+1)
	for i := 0; i < MaxSecretEnvEntries+1; i++ {
		m[fmt.Sprintf("key_%02d", i)] = "valid-length-value"
	}

	_, err := ParseSecretEnv(m)
	if err == nil {
		t.Fatalf("ParseSecretEnv with %d entries = nil error, want error", len(m))
	}
}

func TestParseSecretEnv_RejectsCaseCollision(t *testing.T) {
	raw := map[string]any{
		"api_token": "value-one-long",
		"API_TOKEN": "value-two-long",
	}

	_, err := ParseSecretEnv(raw)
	if err == nil {
		t.Fatal("ParseSecretEnv with case-colliding keys = nil error, want error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "api_token") || !strings.Contains(msg, "API_TOKEN") {
		t.Errorf("error %q does not name both colliding keys", msg)
	}
}

// TestSecretEnv_RedactsEveryRepresentation is the empirical check the brief
// calls out: NO format verb, and no serialization path, may extract the
// plaintext value. Every representation must both omit the plaintext and
// carry the [REDACTED] marker.
func TestSecretEnv_RedactsEveryRepresentation(t *testing.T) {
	const secretValue = "super-secret-value"
	se := SecretEnv{"api_token": secretValue}

	jsonBytes, err := json.Marshal(se)
	if err != nil {
		t.Fatalf("json.Marshal(se) unexpected error: %v", err)
	}

	reps := map[string]string{
		"%v":           fmt.Sprintf("%v", se),
		"%+v":          fmt.Sprintf("%+v", se),
		"%#v":          fmt.Sprintf("%#v", se),
		"%s":           fmt.Sprintf("%s", se),
		"%q":           fmt.Sprintf("%q", se),
		"%x":           fmt.Sprintf("%x", se),
		"String()":     se.String(),
		"json.Marshal": string(jsonBytes),
	}

	for label, rep := range reps {
		if strings.Contains(rep, secretValue) {
			t.Errorf("representation %s leaks the secret value: %q", label, rep)
		}
		if !strings.Contains(rep, "[REDACTED]") {
			t.Errorf("representation %s = %q, want it to contain the [REDACTED] marker", label, rep)
		}
	}
}

func TestSecretEnv_UnmarshalJSON_AlwaysFails(t *testing.T) {
	var se SecretEnv
	err := json.Unmarshal([]byte(`{"api_token":"super-secret-value"}`), &se)
	if err == nil {
		t.Fatal("json.Unmarshal into SecretEnv = nil error, want error (ParseSecretEnv is the only supported constructor)")
	}
}

func TestSecretEnv_Values(t *testing.T) {
	se := SecretEnv{
		"api_token":  "value-one-long",
		"db_pass":    "value-two-long",
		"webhook_id": "value-three-long",
	}

	got := se.Values()
	if len(got) != len(se) {
		t.Fatalf("Values() returned %d values, want %d", len(got), len(se))
	}

	want := map[string]int{}
	for _, v := range se {
		want[v]++
	}
	gotCount := map[string]int{}
	for _, v := range got {
		gotCount[v]++
	}
	for v, n := range want {
		if gotCount[v] != n {
			t.Errorf("Values() contains %q %d times, want %d", v, gotCount[v], n)
		}
	}
}

func TestSecretEnv_EnvKey(t *testing.T) {
	var se SecretEnv
	if got, want := se.EnvKey("api_token"), "BREEZE_VAR_API_TOKEN"; got != want {
		t.Errorf("EnvKey(%q) = %q, want %q", "api_token", got, want)
	}
}
