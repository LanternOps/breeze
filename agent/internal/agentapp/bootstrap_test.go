package agentapp

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
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
			// Self-hosted server on a nonstandard port (#2341): the filename
			// carries `host_8443` (Windows filenames cannot contain `:`) and the
			// resolved server URL must come back as https://host:8443.
			name:       "paren filename token with encoded port",
			data:       `C:\Users\me\Downloads\Breeze Agent (6KE9MDUG56@rmm.acme.example_8443).msi||`,
			wantToken:  "6KE9MDUG56",
			wantServer: "https://rmm.acme.example:8443",
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
			// Post-fix the BootstrapEnroll CA formats [OriginalDatabase] directly
			// into the command line, so install-data is ALWAYS a non-empty MSI path
			// (never the old "" empty arg). A plain install whose filename carries no
			// (TOKEN@HOST) must still resolve to errNoBootstrapInput so runBootstrap
			// soft-exits 0 — otherwise the deferred CA's Return="check" would roll
			// back every tokenless/manual install.
			name:    "real product filename without token (manual install, must not error-rollback)",
			data:    `C:\Program Files\Breeze\Breeze Agent.msi||`,
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

// The MSI BootstrapEnroll CA runs on major upgrades too. An already-enrolled
// agent must return before ANY HTTP redemption: the bootstrap token is
// single-use, so a redeem-then-skip flow burns the customer's token (and an
// already-redeemed filename token would 4xx → exit 1 → the deferred CA's
// Return="check" rolls back the entire upgrade).
func TestRunBootstrapSkipsRedeemWhenAlreadyEnrolled(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	// agent_id must be a VALID UUID: config.Load validates it and falls back
	// to Default() (empty AgentID) on an invalid value — which correctly
	// fails OPEN into enrollment, but would vacuously pass the wrong way here.
	if err := os.WriteFile(cfgPath, []byte(
		"agent_id: 0f0e0d0c-0b0a-4908-8706-050403020100\nlog_file: "+filepath.ToSlash(filepath.Join(dir, "agent.log"))+"\n",
	), 0o600); err != nil {
		t.Fatal(err)
	}

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1) // single-use token: any request here IS the bug
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	origCfg, origData, origQuiet := cfgFile, bootstrapInstallData, quietEnroll
	t.Cleanup(func() { cfgFile, bootstrapInstallData, quietEnroll = origCfg, origData, origQuiet })
	cfgFile, quietEnroll = cfgPath, true
	bootstrapInstallData = `C:\dl\breeze-agent.msi|TESTTOKEN1|` + srv.URL

	origExit := osExit
	osExit = func(code int) { panic(fmt.Sprintf("unexpected exit %d", code)) }
	t.Cleanup(func() { osExit = origExit })

	runBootstrap()

	if n := hits.Load(); n != 0 {
		t.Fatalf("bootstrap endpoint contacted %d time(s) despite existing enrollment — single-use token would be burned on upgrade", n)
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
