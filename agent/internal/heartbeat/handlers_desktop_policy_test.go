package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// Findings #2 and #7: the agent must derive the clipboard direction gates and
// session-lifetime limits from the start_desktop payload, defaulting to
// permissive (preserve behavior) only when the API omits them.
func TestParseDesktopSessionPolicy(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    desktop.SessionPolicy
	}{
		{
			name:    "absent clipboard defaults to permissive (preserve behavior)",
			payload: map[string]any{},
			want: desktop.SessionPolicy{
				ClipboardHostToViewer: true,
				ClipboardViewerToHost: true,
			},
		},
		{
			name: "host-to-viewer disabled (hosted silent-exfil guard)",
			payload: map[string]any{
				"clipboard": map[string]any{"hostToViewer": false, "viewerToHost": true},
			},
			want: desktop.SessionPolicy{
				ClipboardHostToViewer: false,
				ClipboardViewerToHost: true,
			},
		},
		{
			name: "both directions disabled",
			payload: map[string]any{
				"clipboard": map[string]any{"hostToViewer": false, "viewerToHost": false},
			},
			want: desktop.SessionPolicy{
				ClipboardHostToViewer: false,
				ClipboardViewerToHost: false,
			},
		},
		{
			name: "timeouts parsed from minutes/hours",
			payload: map[string]any{
				"idleTimeoutMinutes":      float64(5),
				"maxSessionDurationHours": float64(8),
			},
			want: desktop.SessionPolicy{
				ClipboardHostToViewer: true,
				ClipboardViewerToHost: true,
				IdleTimeout:           5 * time.Minute,
				MaxDuration:           8 * time.Hour,
			},
		},
		{
			name: "idle timeout clamps to direct-mode cap",
			payload: map[string]any{
				"idleTimeoutMinutes": float64(100000),
			},
			want: desktop.SessionPolicy{
				ClipboardHostToViewer: true,
				ClipboardViewerToHost: true,
				IdleTimeout:           1440 * time.Minute,
			},
		},
		{
			name: "max session duration clamps to direct-mode cap",
			payload: map[string]any{
				"maxSessionDurationHours": float64(100000),
			},
			want: desktop.SessionPolicy{
				ClipboardHostToViewer: true,
				ClipboardViewerToHost: true,
				MaxDuration:           168 * time.Hour,
			},
		},
		{
			name: "zero/absent timeouts mean disabled",
			payload: map[string]any{
				"idleTimeoutMinutes":      float64(0),
				"maxSessionDurationHours": float64(0),
			},
			want: desktop.SessionPolicy{
				ClipboardHostToViewer: true,
				ClipboardViewerToHost: true,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseDesktopSessionPolicy(tt.payload)
			if got != tt.want {
				t.Fatalf("parseDesktopSessionPolicy() = %+v, want %+v", got, tt.want)
			}
		})
	}
}
