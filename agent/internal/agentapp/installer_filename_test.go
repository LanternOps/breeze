package agentapp

import "testing"

func TestParseInstallerFilenameToken(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		wantTok   string
		wantHost  string
		wantError bool
	}{
		// Parenthesis form — canonical for Windows MSI. Square brackets collide
		// with MSI's Formatted-field [property] syntax and get stripped when the
		// download filename flows through OriginalDatabase -> CustomActionData,
		// so the Windows installer download uses parens instead (issue #1956).
		{"paren clean", "Breeze Agent (ABCDE12345@eu.2breeze.app).msi", "ABCDE12345", "eu.2breeze.app", false},
		{"paren full windows path", `C:\ProgramData\NinjaRMMAgent\download\Breeze Agent (6KE9MDUG56@us.2breeze.app).msi`, "6KE9MDUG56", "us.2breeze.app", false},
		{"paren browser dup suffix", "Breeze Agent (ABCDE12345@us.2breeze.app) (1).msi", "ABCDE12345", "us.2breeze.app", false},
		{"paren host with hyphen", "Breeze Agent (ABCDE12345@my-rmm.example).msi", "ABCDE12345", "my-rmm.example", false},
		{"paren token too short", "Breeze Agent (ABCDE1234@host).msi", "", "", true},
		{"paren token lowercase", "Breeze Agent (abcde12345@host).msi", "", "", true},
		// Bracket form — legacy / macOS (.app bundle name). Still accepted.
		{"bracket clean", "Breeze Agent [ABCDE12345@eu.2breeze.app].msi", "ABCDE12345", "eu.2breeze.app", false},
		{"bracket browser dup suffix", "Breeze Agent [ABCDE12345@us.2breeze.app] (1).msi", "ABCDE12345", "us.2breeze.app", false},
		{"bracket full path", `C:\Users\me\Downloads\Breeze Agent [Z9Y8X7W6V5@host.example.com].msi`, "Z9Y8X7W6V5", "host.example.com", false},
		{"bracket host with hyphen", "Breeze Agent [ABCDE12345@my-rmm.example].msi", "ABCDE12345", "my-rmm.example", false},
		{"no delimiter", "breeze-agent.msi", "", "", true},
		{"bracket token too short", "Breeze Agent [ABCDE1234@host].msi", "", "", true},
		{"bracket token lowercase", "Breeze Agent [abcde12345@host].msi", "", "", true},
		{"empty", "", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tok, host, err := parseInstallerFilenameToken(tc.input)
			if tc.wantError {
				if err == nil {
					t.Fatalf("expected error, got token=%q host=%q", tok, host)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tok != tc.wantTok || host != tc.wantHost {
				t.Fatalf("got (%q,%q), want (%q,%q)", tok, host, tc.wantTok, tc.wantHost)
			}
		})
	}
}
