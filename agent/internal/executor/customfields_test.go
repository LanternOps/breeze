package executor

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestExtractCustomFields(t *testing.T) {
	tests := []struct {
		name       string
		stdout     string
		wantFields map[string]any
		wantStdout string
	}{
		{
			name:       "no marker",
			stdout:     "hello\nworld\n",
			wantFields: nil,
			wantStdout: "hello\nworld\n",
		},
		{
			name:       "single marker is extracted and removed",
			stdout:     "scanning\n::breeze:custom-fields:: {\"a\":\"1\"}\ndone\n",
			wantFields: map[string]any{"a": "1"},
			wantStdout: "scanning\ndone\n",
		},
		{
			name:       "later marker wins",
			stdout:     "::breeze:custom-fields:: {\"a\":1}\n::breeze:custom-fields:: {\"a\":2,\"b\":3}\n",
			wantFields: map[string]any{"a": float64(2), "b": float64(3)},
			wantStdout: "",
		},
		{
			name:       "secret-shaped value survives because we run before SanitizeOutput",
			stdout:     "::breeze:custom-fields:: {\"vault_token_id\":\"abcdefgh\"}\n",
			wantFields: map[string]any{"vault_token_id": "abcdefgh"},
			wantStdout: "",
		},
		{
			name:       "unparseable marker is left in stdout for the operator to see",
			stdout:     "::breeze:custom-fields:: {\"a\":\n",
			wantFields: nil,
			wantStdout: "::breeze:custom-fields:: {\"a\":\n",
		},
		{
			name:       "CRLF line endings",
			stdout:     "::breeze:custom-fields:: {\"a\":\"1\"}\r\nx\r\n",
			wantFields: map[string]any{"a": "1"},
			wantStdout: "x\r\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fields, stdout := ExtractCustomFields(tt.stdout)
			if !reflect.DeepEqual(fields, tt.wantFields) {
				t.Fatalf("fields = %#v, want %#v", fields, tt.wantFields)
			}
			if stdout != tt.wantStdout {
				t.Fatalf("stdout = %q, want %q", stdout, tt.wantStdout)
			}
		})
	}
}

// TestExtractCustomFieldsCaps proves the line count cap actually caps: 25
// marker lines, each setting a DISTINCT key so the assertion cannot pass by
// accident (25 identical-key lines would merge to 1 key regardless of
// whether the cap exists at all — that was the bug in the version of this
// test this replaces).
func TestExtractCustomFieldsCaps(t *testing.T) {
	var lines []string
	for i := 0; i < 25; i++ {
		lines = append(lines, fmt.Sprintf(`::breeze:custom-fields:: {"k%d":%d}`, i, i))
	}
	stdout := strings.Join(lines, "\n") + "\n"

	fields, remaining := ExtractCustomFields(stdout)

	if len(fields) != maxCustomFieldMarkerLines {
		t.Fatalf("expected exactly %d keys (one per applied line), got %d: %#v", maxCustomFieldMarkerLines, len(fields), fields)
	}
	for i := 0; i < maxCustomFieldMarkerLines; i++ {
		key := fmt.Sprintf("k%d", i)
		if fields[key] != float64(i) {
			t.Errorf("fields[%q] = %#v, want %v (line %d should have been applied)", key, fields[key], i, i)
		}
	}
	for i := maxCustomFieldMarkerLines; i < 25; i++ {
		key := fmt.Sprintf("k%d", i)
		if _, present := fields[key]; present {
			t.Errorf("fields[%q] present, want absent — line %d is past the %d-line cap", key, i, maxCustomFieldMarkerLines)
		}
	}
	// The rejected lines (20-24) must still be visible in the returned
	// stdout — that's the whole point of rejecting at line granularity.
	for i := maxCustomFieldMarkerLines; i < 25; i++ {
		marker := fmt.Sprintf(`{"k%d":%d}`, i, i)
		if !strings.Contains(remaining, marker) {
			t.Errorf("expected rejected line %d to remain visible in stdout, got %q", i, remaining)
		}
	}
}

// TestExtractCustomFieldsKeyCapRejectsWholeLine proves the 50-distinct-key
// cap rejects an over-cap marker line WHOLESALE and deterministically —
// never partially merging some of its keys per Go's randomized map iteration
// order and dropping the rest with no trace (the bug this test guards
// against: the original implementation looped `for k, v := range parsed`
// and silently `continue`d past the cap key-by-key inside a single line).
func TestExtractCustomFieldsKeyCapRejectsWholeLine(t *testing.T) {
	// One marker line establishing exactly 50 keys — fills the cap exactly.
	first := make([]string, maxCustomFieldKeys)
	for i := range first {
		first[i] = fmt.Sprintf(`"a%d":%d`, i, i)
	}
	firstLine := "::breeze:custom-fields:: {" + strings.Join(first, ",") + "}"

	// A second marker line with two BRAND NEW keys — merging it would push
	// the total to 52, over the cap, so it must be rejected in full.
	secondLine := `::breeze:custom-fields:: {"new1":"x","new2":"y"}`

	stdout := firstLine + "\n" + secondLine + "\n"
	fields, remaining := ExtractCustomFields(stdout)

	if len(fields) != maxCustomFieldKeys {
		t.Fatalf("expected exactly %d keys from the first line, got %d", maxCustomFieldKeys, len(fields))
	}
	if _, present := fields["new1"]; present {
		t.Error(`fields["new1"] present, want absent — the whole second line should have been rejected`)
	}
	if _, present := fields["new2"]; present {
		t.Error(`fields["new2"] present, want absent — the whole second line should have been rejected`)
	}
	if !strings.Contains(remaining, "new1") {
		t.Errorf("expected the rejected second line to remain visible in stdout, got %q", remaining)
	}
}

// TestExtractCustomFieldsKeyCapAllowsUpdatesToExistingKeys proves that a
// later line can still freely UPDATE keys already present, even once the
// cap is full — "later lines win" stays true for existing keys; only NEW
// keys past the cap are rejected (with the whole line, per the test above).
func TestExtractCustomFieldsKeyCapAllowsUpdatesToExistingKeys(t *testing.T) {
	first := make([]string, maxCustomFieldKeys)
	for i := range first {
		first[i] = fmt.Sprintf(`"a%d":%d`, i, i)
	}
	firstLine := "::breeze:custom-fields:: {" + strings.Join(first, ",") + "}"
	secondLine := `::breeze:custom-fields:: {"a0":"updated"}`

	stdout := firstLine + "\n" + secondLine + "\n"
	fields, remaining := ExtractCustomFields(stdout)

	if len(fields) != maxCustomFieldKeys {
		t.Fatalf("expected exactly %d keys, got %d", maxCustomFieldKeys, len(fields))
	}
	if fields["a0"] != "updated" {
		t.Errorf(`fields["a0"] = %#v, want "updated" — an update-only line must still apply once the cap is full`, fields["a0"])
	}
	if strings.Contains(remaining, `"a0":"updated"`) {
		t.Errorf("the update-only second line should have been consumed, not left in stdout: %q", remaining)
	}
}

// TestExtractCustomFieldsJSONSizeCap proves an oversized marker payload is
// rejected and left visible in stdout, matching the other two caps.
func TestExtractCustomFieldsJSONSizeCap(t *testing.T) {
	// One key whose value alone exceeds maxCustomFieldJSONBytes (8192).
	oversizedValue := strings.Repeat("x", maxCustomFieldJSONBytes)
	line := fmt.Sprintf(`::breeze:custom-fields:: {"a":"%s"}`, oversizedValue)

	fields, remaining := ExtractCustomFields(line + "\n")

	if fields != nil {
		t.Fatalf("expected no fields from an oversized marker, got %#v", fields)
	}
	if !strings.Contains(remaining, CustomFieldMarker) {
		t.Errorf("expected the oversized marker line to remain visible in stdout, got %q", remaining)
	}
}
