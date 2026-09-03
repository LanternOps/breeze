package executor

import (
	"reflect"
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

func TestExtractCustomFieldsCaps(t *testing.T) {
	var b []byte
	for i := 0; i < 25; i++ {
		b = append(b, []byte("::breeze:custom-fields:: {\"k\":1}\n")...)
	}
	fields, _ := ExtractCustomFields(string(b))
	if len(fields) != 1 {
		t.Fatalf("expected the merged map to hold 1 key, got %d", len(fields))
	}
}
