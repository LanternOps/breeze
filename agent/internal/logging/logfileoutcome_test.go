package logging

import (
	"errors"
	"testing"
)

func TestLogFileOutcome(t *testing.T) {
	openErr := errors.New("permission denied")
	mkdirErr := errors.New("mkdir: read-only")
	homeErr := errors.New("$HOME is not defined")

	tests := []struct {
		name      string
		path      string
		openErr   error
		mkdirErr  error
		homeErr   error
		wantWarn  bool
		wantMsg   string
		wantAttrs []any
	}{
		{
			name:      "success records the path at info",
			path:      "/Users/canary/Library/Logs/Breeze/desktop-helper.log",
			wantWarn:  false,
			wantMsg:   "helper log file opened",
			wantAttrs: []any{"path", "/Users/canary/Library/Logs/Breeze/desktop-helper.log"},
		},
		{
			// The #5877 shape: the directory exists (root created it) but
			// the open fails because it is 0700 root-owned.
			name:      "open failure warns with path and error",
			path:      "/Library/Application Support/Breeze/logs/desktop-helper.log",
			openErr:   openErr,
			wantWarn:  true,
			wantMsg:   "helper log file unavailable; logging to stdout only",
			wantAttrs: []any{"path", "/Library/Application Support/Breeze/logs/desktop-helper.log", "error", openErr},
		},
		{
			name:      "mkdir failure is reported alongside the open failure",
			path:      "/Library/Application Support/Breeze/logs/user-helper.log",
			openErr:   openErr,
			mkdirErr:  mkdirErr,
			wantWarn:  true,
			wantMsg:   "helper log file unavailable; logging to stdout only",
			wantAttrs: []any{"path", "/Library/Application Support/Breeze/logs/user-helper.log", "error", openErr, "mkdirError", mkdirErr},
		},
		{
			// An unresolvable home directory is WHY a macOS helper ends
			// up against the shared root-owned directory, so it has to be
			// distinguishable from a plain permissions failure.
			name:      "unresolvable home directory is reported as the cause",
			path:      "/Library/Application Support/Breeze/logs/desktop-helper.log",
			openErr:   openErr,
			homeErr:   homeErr,
			wantWarn:  true,
			wantMsg:   "helper log file unavailable; logging to stdout only",
			wantAttrs: []any{"path", "/Library/Application Support/Breeze/logs/desktop-helper.log", "error", openErr, "homeDirError", homeErr},
		},
		{
			// A mkdir error with a successful open is not actionable —
			// the directory already existed. Don't cry wolf.
			name:      "mkdir failure with a successful open stays quiet",
			path:      "/var/log/breeze/user-helper.log",
			mkdirErr:  mkdirErr,
			wantWarn:  false,
			wantMsg:   "helper log file opened",
			wantAttrs: []any{"path", "/var/log/breeze/user-helper.log"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			warn, msg, attrs := LogFileOutcome(tt.path, tt.openErr, tt.mkdirErr, tt.homeErr)
			if warn != tt.wantWarn {
				t.Errorf("warn = %v, want %v", warn, tt.wantWarn)
			}
			if msg != tt.wantMsg {
				t.Errorf("msg = %q, want %q", msg, tt.wantMsg)
			}
			if len(attrs) != len(tt.wantAttrs) {
				t.Fatalf("attrs = %v, want %v", attrs, tt.wantAttrs)
			}
			for i := range attrs {
				if attrs[i] != tt.wantAttrs[i] {
					t.Errorf("attrs[%d] = %v, want %v", i, attrs[i], tt.wantAttrs[i])
				}
			}
		})
	}
}
