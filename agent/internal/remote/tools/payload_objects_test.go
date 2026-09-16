package tools

import "testing"

func TestGetPayloadObjectSlice(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		key     string
		want    []map[string]any
	}{
		{
			name: "array of objects",
			payload: map[string]any{"oidSpecs": []any{
				map[string]any{"oid": "1.3.6.1.2.1.1.3.0", "mode": "get"},
				map[string]any{"oid": "1.3.6.1.2.1.2.2.1.2", "mode": "walk"},
			}},
			key: "oidSpecs",
			want: []map[string]any{
				{"oid": "1.3.6.1.2.1.1.3.0", "mode": "get"},
				{"oid": "1.3.6.1.2.1.2.2.1.2", "mode": "walk"},
			},
		},
		{name: "missing key", payload: map[string]any{}, key: "oidSpecs", want: nil},
		{name: "nil payload", payload: nil, key: "oidSpecs", want: nil},
		{name: "not an array", payload: map[string]any{"oidSpecs": "nope"}, key: "oidSpecs", want: nil},
		{name: "empty array", payload: map[string]any{"oidSpecs": []any{}}, key: "oidSpecs", want: []map[string]any{}},
		{
			name:    "non-object members are dropped, objects survive",
			payload: map[string]any{"oidSpecs": []any{"junk", 42, nil, map[string]any{"oid": "1.3"}}},
			key:     "oidSpecs",
			want:    []map[string]any{{"oid": "1.3"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetPayloadObjectSlice(tt.payload, tt.key)
			if len(got) != len(tt.want) {
				t.Fatalf("GetPayloadObjectSlice() = %v (len %d), want %v (len %d)", got, len(got), tt.want, len(tt.want))
			}
			for i := range got {
				for k, v := range tt.want[i] {
					if got[i][k] != v {
						t.Errorf("entry %d key %q = %v, want %v", i, k, got[i][k], v)
					}
				}
			}
		})
	}
}

func TestGetPayloadObject(t *testing.T) {
	tests := []struct {
		name     string
		payload  map[string]any
		key      string
		wantNil  bool
		wantKeys map[string]any
	}{
		{
			name:     "object",
			payload:  map[string]any{"limits": map[string]any{"maxRowsPerOid": float64(512)}},
			key:      "limits",
			wantKeys: map[string]any{"maxRowsPerOid": float64(512)},
		},
		{name: "missing key", payload: map[string]any{}, key: "limits", wantNil: true},
		{name: "nil payload", payload: nil, key: "limits", wantNil: true},
		{name: "wrong type", payload: map[string]any{"limits": []any{1}}, key: "limits", wantNil: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetPayloadObject(tt.payload, tt.key)
			if tt.wantNil {
				if got != nil {
					t.Fatalf("GetPayloadObject() = %v, want nil", got)
				}
				return
			}
			for k, v := range tt.wantKeys {
				if got[k] != v {
					t.Errorf("key %q = %v, want %v", k, got[k], v)
				}
			}
		})
	}
}
