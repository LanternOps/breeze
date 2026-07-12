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
		// _PORT suffix — nonstandard self-hosted port carried in the filename
		// (issue #2341). `:` is illegal in Windows filenames, so the server
		// encodes `host:8443` as `host_8443`; the parser reconstructs it.
		{"paren host with port", "Breeze Agent (ABCDE12345@my-rmm.example_8443).msi", "ABCDE12345", "my-rmm.example:8443", false},
		{"paren host with port dup suffix", "Breeze Agent (ABCDE12345@my-rmm.example_8443) (1).msi", "ABCDE12345", "my-rmm.example:8443", false},
		{"paren host with port full path", `C:\Users\me\Downloads\Breeze Agent (6KE9MDUG56@rmm.acme.example_8443).msi`, "6KE9MDUG56", "rmm.acme.example:8443", false},
		// Chrome-sanitized download from a pre-fix server that emitted
		// `host:8443` in Content-Disposition: the browser substitutes `_` for
		// the illegal `:`, which is exactly the encoded form — must parse.
		{"paren chrome-sanitized legacy colon", "Breeze Agent (ABCDE12345@self-hosted.example_9443).msi", "ABCDE12345", "self-hosted.example:9443", false},
		{"paren port too long", "Breeze Agent (ABCDE12345@host_123456).msi", "", "", true},
		{"paren underscore non-numeric suffix", "Breeze Agent (ABCDE12345@host_evil).msi", "", "", true},
		// Bracket form — legacy / macOS (.app bundle name). Still accepted.
		{"bracket clean", "Breeze Agent [ABCDE12345@eu.2breeze.app].msi", "ABCDE12345", "eu.2breeze.app", false},
		{"bracket browser dup suffix", "Breeze Agent [ABCDE12345@us.2breeze.app] (1).msi", "ABCDE12345", "us.2breeze.app", false},
		{"bracket full path", `C:\Users\me\Downloads\Breeze Agent [Z9Y8X7W6V5@host.example.com].msi`, "Z9Y8X7W6V5", "host.example.com", false},
		{"bracket host with hyphen", "Breeze Agent [ABCDE12345@my-rmm.example].msi", "ABCDE12345", "my-rmm.example", false},
		{"bracket host with port", "Breeze Agent [ABCDE12345@my-rmm.example_8443].msi", "ABCDE12345", "my-rmm.example:8443", false},
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
