package agentapp

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResolveBootstrapInputs(t *testing.T) {
	cases := []struct {
		name       string
		data       string
		wantToken  string
		wantServer string
		wantErr    error
	}{
		{
			name:       "filename token only",
			data:       `C:\dl\Breeze Agent [ABCDE12345@eu.2breeze.app].msi||`,
			wantToken:  "ABCDE12345",
			wantServer: "https://eu.2breeze.app",
		},
		{
			// Real-world Windows shape: NinjaRMM silent install, parens delimiter,
			// empty BOOTSTRAP_TOKEN/SERVER_URL properties (issue #1956).
			name:       "paren filename token (windows MSI form)",
			data:       `C:\ProgramData\NinjaRMMAgent\download\Breeze Agent (6KE9MDUG56@us.2breeze.app).msi||`,
			wantToken:  "6KE9MDUG56",
			wantServer: "https://us.2breeze.app",
		},
		{
			name:       "property token + server wins over filename",
			data:       `C:\dl\Breeze Agent [ABCDE12345@eu.2breeze.app].msi|ZZZZZ99999|https://us.2breeze.app`,
			wantToken:  "ZZZZZ99999",
			wantServer: "https://us.2breeze.app",
		},
		{
			name:    "no token anywhere",
			data:    `C:\dl\breeze-agent.msi||`,
			wantErr: errNoBootstrapInput,
		},
		{
			name:       "property token without server falls back to filename",
			data:       `C:\dl\Breeze Agent [ABCDE12345@eu.2breeze.app].msi|ZZZZZ99999|`,
			wantToken:  "ABCDE12345",
			wantServer: "https://eu.2breeze.app",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tok, server, err := resolveBootstrapInputs(tc.data)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("want err %v, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tok != tc.wantToken || server != tc.wantServer {
				t.Fatalf("got (%q,%q), want (%q,%q)", tok, server, tc.wantToken, tc.wantServer)
			}
		})
	}
}

func TestRedeemBootstrapToken(t *testing.T) {
	var gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Breeze-Bootstrap-Token")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"serverUrl":"` + "http://x" + `","enrollmentKey":"deadbeef","enrollmentSecret":"s","siteId":"site1"}`))
	}))
	defer srv.Close()

	res, err := redeemBootstrapToken(srv.URL, "ABCDE12345")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotToken != "ABCDE12345" {
		t.Fatalf("token header not sent, got %q", gotToken)
	}
	if res.EnrollmentKey != "deadbeef" || res.SiteID != "site1" {
		t.Fatalf("unexpected result: %+v", res)
	}
}
