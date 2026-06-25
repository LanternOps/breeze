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
		{"clean", "Breeze Agent [ABCDE12345@eu.2breeze.app].msi", "ABCDE12345", "eu.2breeze.app", false},
		{"browser dup suffix", "Breeze Agent [ABCDE12345@us.2breeze.app] (1).msi", "ABCDE12345", "us.2breeze.app", false},
		{"full path", `C:\Users\me\Downloads\Breeze Agent [Z9Y8X7W6V5@host.example.com].msi`, "Z9Y8X7W6V5", "host.example.com", false},
		{"host with hyphen", "Breeze Agent [ABCDE12345@my-rmm.example].msi", "ABCDE12345", "my-rmm.example", false},
		{"no brackets", "breeze-agent.msi", "", "", true},
		{"token too short", "Breeze Agent [ABCDE1234@host].msi", "", "", true},
		{"token lowercase", "Breeze Agent [abcde12345@host].msi", "", "", true},
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
