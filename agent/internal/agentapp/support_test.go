package agentapp

import (
	"errors"
	"testing"
	"time"
)

func TestResolveSupportInput(t *testing.T) {
	cases := []struct {
		name       string
		argv0      string
		codeFlag   string
		serverFlag string
		wantCode   string
		wantServer string
		wantErr    bool
	}{
		// Explicit flags always win over whatever the filename carries — a
		// technician re-running a downloaded client with --code must not be
		// silently redirected to the embedded (already-consumed) code.
		{
			name:       "flags win over filename",
			argv0:      `C:\Users\me\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app.exe`,
			codeFlag:   "ABCDEFGHJ",
			serverFlag: "https://eu.2breeze.app",
			wantCode:   "ABCDEFGHJ",
			wantServer: "https://eu.2breeze.app",
		},
		{
			name:       "filename parsed when no flags",
			argv0:      `C:\Users\me\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app.exe`,
			wantCode:   "KTM4H7P2X",
			wantServer: "https://us.2breeze.app",
		},
		// Chrome/Edge insert a SPACE before the duplicate-download marker...
		{
			name:       "chrome duplicate-download marker with space",
			argv0:      `C:\Users\me\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app (1).exe`,
			wantCode:   "KTM4H7P2X",
			wantServer: "https://us.2breeze.app",
		},
		// ...Firefox does not. Both must parse or the client silently falls
		// back to an interactive prompt for a code the user already "has".
		{
			name:       "firefox duplicate-download marker without space",
			argv0:      `C:\Users\me\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app(1).exe`,
			wantCode:   "KTM4H7P2X",
			wantServer: "https://us.2breeze.app",
		},
		{
			name:       "multi-digit duplicate marker",
			argv0:      "breeze-support-KTM4H7P2X-us.2breeze.app (12).exe",
			wantCode:   "KTM4H7P2X",
			wantServer: "https://us.2breeze.app",
		},
		{
			name:       "mixed-case filename normalizes the code to upper case",
			argv0:      "Breeze-Support-ktm4h7p2x-US.2Breeze.App.exe",
			wantCode:   "KTM4H7P2X",
			wantServer: "https://US.2Breeze.App",
		},
		// Nonstandard port: `:` is illegal in a Windows filename (Chromium
		// rewrites it to `_` at save time — exactly how #2341 shipped
		// silently-unenrolled installs), so the server encodes host:port as
		// host_port. Without the decode the "https://" prepend produces a
		// broken URL on every self-hosted/dev deployment.
		{
			name:       "underscore port suffix decodes back to a colon",
			argv0:      "breeze-support-KTM4H7P2X-localhost_3000.exe",
			wantCode:   "KTM4H7P2X",
			wantServer: "https://localhost:3000",
		},
		{
			name:       "underscore port suffix with duplicate marker",
			argv0:      "breeze-support-KTM4H7P2X-rmm.acme.example_8443 (1).exe",
			wantCode:   "KTM4H7P2X",
			wantServer: "https://rmm.acme.example:8443",
		},
		// Only the LAST underscore group is a port, and only when it is
		// all digits — mirrors installer_filename.go's `_([0-9]{1,5})$`.
		{
			name:       "non-numeric underscore suffix is part of the host",
			argv0:      "breeze-support-KTM4H7P2X-host_evil.exe",
			wantCode:   "KTM4H7P2X",
			wantServer: "https://host_evil",
		},
		{
			name:       "port longer than five digits is not a port",
			argv0:      "breeze-support-KTM4H7P2X-host_123456.exe",
			wantCode:   "KTM4H7P2X",
			wantServer: "https://host_123456",
		},
		// A dashed display code (XXX-XXX-XXX) is what the technician reads
		// out loud, so the flag must accept it verbatim.
		{
			name:     "dashed display code from the flag is normalized",
			argv0:    "breeze-agent",
			codeFlag: "ktm-4h7-p2x",
			wantCode: "KTM4H7P2X",
		},
		// The current mint alphabet is digits 2-9 only, so the all-digit code
		// is the ordinary case, not an edge case: it must parse out of the
		// filename and off the flag exactly like the legacy letter codes.
		{
			name:       "digits-only code parsed from the filename",
			argv0:      `C:\Users\me\Downloads\breeze-support-234567892-us.2breeze.app.exe`,
			wantCode:   "234567892",
			wantServer: "https://us.2breeze.app",
		},
		{
			name:       "digits-only code with a duplicate-download marker",
			argv0:      "breeze-support-234567892-us.2breeze.app (1).exe",
			wantCode:   "234567892",
			wantServer: "https://us.2breeze.app",
		},
		{
			name:       "digits-only code with an underscore port suffix",
			argv0:      "breeze-support-987654323-localhost_3000.exe",
			wantCode:   "987654323",
			wantServer: "https://localhost:3000",
		},
		{
			name:     "dashed digits-only display code from the flag",
			argv0:    "breeze-agent",
			codeFlag: "234-567-892",
			wantCode: "234567892",
		},
		// The filename regex is deliberately wider than the code alphabet
		// ([a-z0-9]{9}) so released binaries survive a future alphabet change.
		// A filename code outside the alphabet therefore reaches supportCodeRe
		// and is rejected THERE — still an error, just a described one rather
		// than a silent "no code embedded".
		{
			name:    "filename code with an out-of-alphabet digit is rejected, not silently ignored",
			argv0:   "breeze-support-234567890-us.2breeze.app.exe",
			wantErr: true,
		},
		{
			name:       "server flag alone still takes the code from the filename",
			argv0:      "breeze-support-KTM4H7P2X-us.2breeze.app.exe",
			serverFlag: "https://self.example",
			wantCode:   "KTM4H7P2X",
			wantServer: "https://self.example",
		},
		// Nothing embedded and no flags -> error so the caller prompts.
		{
			name:    "plain agent binary with no flags errors",
			argv0:   "breeze-agent",
			wantErr: true,
		},
		{
			name:    "support-prefixed binary with no embedded code errors",
			argv0:   "breeze-support.exe",
			wantErr: true,
		},
		// Letters excluded from the alphabet (I/L/O/U) and digits 0/1 are
		// rejected rather than redeemed as a typo'd code.
		{
			name:     "code containing an excluded letter is rejected",
			argv0:    "breeze-agent",
			codeFlag: "KTM4H7P2I",
			wantErr:  true,
		},
		{
			name:     "code containing a zero is rejected",
			argv0:    "breeze-agent",
			codeFlag: "KTM4H7P20",
			wantErr:  true,
		},
		{
			name:     "short code is rejected",
			argv0:    "breeze-agent",
			codeFlag: "KTM4H7P",
			wantErr:  true,
		},
		{
			name:    "eight-char filename code does not match",
			argv0:   "breeze-support-KTM4H7P2-us.2breeze.app.exe",
			wantErr: true,
		},
		{
			name:    "non-exe extension does not match",
			argv0:   "breeze-support-KTM4H7P2X-us.2breeze.app.msi",
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, server, err := resolveSupportInput(tc.argv0, tc.codeFlag, tc.serverFlag)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got code=%q server=%q", code, server)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if code != tc.wantCode {
				t.Errorf("code: got %q, want %q", code, tc.wantCode)
			}
			if server != tc.wantServer {
				t.Errorf("server: got %q, want %q", server, tc.wantServer)
			}
		})
	}
}

// The "nothing supplied" case must be distinguishable from "supplied but
// malformed" only insofar as both send the caller to the interactive prompt;
// the sentinel exists so the prompt path can stay silent instead of printing
// a validation complaint about input the user never gave.
func TestResolveSupportInputMissingSentinel(t *testing.T) {
	_, _, err := resolveSupportInput("breeze-agent", "", "")
	if !errors.Is(err, errNoSupportCode) {
		t.Fatalf("expected errNoSupportCode, got %v", err)
	}

	_, _, err = resolveSupportInput("breeze-agent", "KTM4H7P20", "")
	if errors.Is(err, errNoSupportCode) {
		t.Fatal("a malformed code must not report as a missing code")
	}
}

func TestSupportWatchdogDecision(t *testing.T) {
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name              string
		disconnectedSince time.Time
		hardExpiresAt     time.Time
		wantEnd           bool
	}{
		{
			name:    "connected and unexpired keeps the session alive",
			wantEnd: false,
		},
		{
			name:              "brief disconnect is tolerated",
			disconnectedSince: now.Add(-2 * time.Minute),
			wantEnd:           false,
		},
		{
			name:              "disconnected for the full grace ends the session",
			disconnectedSince: now.Add(-supportDisconnectGrace),
			wantEnd:           true,
		},
		{
			name:              "disconnected well past the grace ends the session",
			disconnectedSince: now.Add(-30 * time.Minute),
			wantEnd:           true,
		},
		{
			name:          "hard expiry in the future keeps the session alive",
			hardExpiresAt: now.Add(time.Minute),
			wantEnd:       false,
		},
		{
			// The backstop for a lost support_end: the server's hard expiry
			// ends the session even while the WebSocket is perfectly healthy.
			name:          "hard expiry in the past ends the session while connected",
			hardExpiresAt: now.Add(-time.Second),
			wantEnd:       true,
		},
		{
			name:          "zero hard expiry is never treated as expired",
			hardExpiresAt: time.Time{},
			wantEnd:       false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			notice := supportWatchdogDecision(now, tc.disconnectedSince, tc.hardExpiresAt)
			if got := notice != ""; got != tc.wantEnd {
				t.Fatalf("end=%v (notice %q), want end=%v", got, notice, tc.wantEnd)
			}
		})
	}
}

func TestSupportWorkDirIsNotTheRealConfigDir(t *testing.T) {
	// The single most dangerous failure mode for this feature: a throwaway
	// support client writing into C:\ProgramData\Breeze would clobber the
	// config, secrets and agent.state of a real permanently-installed agent
	// on the same machine.
	dir := supportWorkDir()
	if dir == "" {
		t.Fatal("support work dir must not be empty")
	}
	if dir == configDirForSupportGuard() {
		t.Fatalf("support work dir %q must never be the real agent config dir", dir)
	}
}
