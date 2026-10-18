package systemrestore

import "testing"

func TestParseRequest(t *testing.T) {
	block := map[string]any{
		"v":              float64(1), // encoding/json decodes numbers as float64
		"requestId":      "3f1d1a0e-0000-4000-8000-000000000001",
		"enabled":        true,
		"label":          "Breeze: install 6 updates",
		"resolvedAt":     "2026-09-02T18:03:11Z",
		"policyRevision": "rev-7",
		"validUntil":     "2026-09-03T18:03:11Z",
	}

	tests := []struct {
		name          string
		payload       map[string]any
		legacyDefault bool
		wantAttempt   bool
		wantRequestID string
	}{
		{
			name:          "explicit enabled block is honoured",
			payload:       map[string]any{"restorePoint": block},
			legacyDefault: false,
			wantAttempt:   true,
			wantRequestID: "3f1d1a0e-0000-4000-8000-000000000001",
		},
		{
			name: "explicit disabled block suppresses the attempt",
			payload: map[string]any{"restorePoint": map[string]any{
				"v": float64(1), "requestId": "abc", "enabled": false,
			}},
			legacyDefault: true, // even on the patch path
			wantAttempt:   false,
			wantRequestID: "abc",
		},
		{
			// Global Constraint 7: a missing block on install_patches means
			// LEGACY BEST-EFFORT ENABLED, so an old server keeps today's
			// behaviour rather than silently losing protection.
			name:          "missing block on the patch path falls back to legacy enabled",
			payload:       map[string]any{},
			legacyDefault: true,
			wantAttempt:   true,
		},
		{
			name:          "missing block on script/software means disabled",
			payload:       map[string]any{},
			legacyDefault: false,
			wantAttempt:   false,
		},
		{
			name:          "nil payload behaves like a missing block",
			payload:       nil,
			legacyDefault: true,
			wantAttempt:   true,
		},
		{
			name:          "an unknown future version falls back to the platform default",
			payload:       map[string]any{"restorePoint": map[string]any{"v": float64(99), "enabled": true, "requestId": "z"}},
			legacyDefault: false,
			wantAttempt:   false,
		},
		{
			name:          "a missing version falls back to the platform default",
			payload:       map[string]any{"restorePoint": map[string]any{"enabled": true, "requestId": "z"}},
			legacyDefault: true,
			wantAttempt:   true,
		},
		{
			name:          "a non-object restorePoint value is ignored",
			payload:       map[string]any{"restorePoint": "yes please"},
			legacyDefault: false,
			wantAttempt:   false,
		},
		{
			name: "a non-boolean enabled is treated as disabled, not truthy",
			payload: map[string]any{"restorePoint": map[string]any{
				"v": float64(1), "requestId": "s", "enabled": "true",
			}},
			legacyDefault: true,
			wantAttempt:   false,
			wantRequestID: "s",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, attempt := ParseRequest(tc.payload, tc.legacyDefault)
			if attempt != tc.wantAttempt {
				t.Fatalf("attempt = %v, want %v", attempt, tc.wantAttempt)
			}
			if req.RequestID != tc.wantRequestID {
				t.Fatalf("RequestID = %q, want %q", req.RequestID, tc.wantRequestID)
			}
		})
	}
}

func TestParseRequestKeepsLabelAndRevision(t *testing.T) {
	req, attempt := ParseRequest(map[string]any{"restorePoint": map[string]any{
		"v": float64(1), "requestId": "r1", "enabled": true,
		"label": "Breeze: run script Cleanup", "policyRevision": "rev-7",
		"resolvedAt": "2026-09-02T18:03:11Z", "validUntil": "2026-09-03T18:03:11Z",
	}}, false)
	if !attempt {
		t.Fatal("expected an attempt")
	}
	want := Request{
		Version: 1, RequestID: "r1", Enabled: true,
		Label: "Breeze: run script Cleanup", PolicyRevision: "rev-7",
		ResolvedAt: "2026-09-02T18:03:11Z", ValidUntil: "2026-09-03T18:03:11Z",
	}
	if req != want {
		t.Fatalf("ParseRequest = %+v, want %+v", req, want)
	}
}
