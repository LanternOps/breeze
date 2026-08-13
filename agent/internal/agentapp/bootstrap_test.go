package agentapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
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
			data:    `C:\dl\nu-agent.msi||`,
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
			data:    `C:\Program Files\Nodes Unlimited\Breeze Agent.msi||`,
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
	bootstrapInstallData = `C:\dl\nu-agent.msi|TESTTOKEN1|` + srv.URL

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

// TestCancelBootstrapIfRefundable is the Step 1 bootstrap-side contract from
// the task brief: on a 4xx enroll-failure category, cancelBootstrap is
// called with whatever child credential it was handed (the raw child
// enrollment KEY in production — see TestRunBootstrap_CancelsSlotOn4xx…);
// on a network-error (or any other
// non-definite-4xx) category, it is NOT called. Table-driven over every
// enrollErrCategory so a future category addition must make an explicit
// choice here rather than silently inheriting a default.
func TestCancelBootstrapIfRefundable(t *testing.T) {
	tests := []struct {
		name       string
		cat        enrollErrCategory
		wantCalled bool
	}{
		{"catAuth (401/403) is refundable", catAuth, true},
		{"catNotFound (404) is refundable", catNotFound, true},
		{"catRateLimit (429) is refundable", catRateLimit, true},
		{"catIdentityConflict is refundable", catIdentityConflict, true},
		{"catNetwork is NOT refundable — enroll may have reached the server", catNetwork, false},
		{"catServer (5xx) is NOT refundable — ambiguous", catServer, false},
		{"catConfig is NOT refundable — never reached the server", catConfig, false},
		{"catUnknown is NOT refundable — ambiguous", catUnknown, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var called bool
			var gotPath, gotSecret string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				gotPath = r.URL.Path
				var body struct {
					EnrollmentSecret string `json:"enrollmentSecret"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				gotSecret = body.EnrollmentSecret
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"refunded":true}`))
			}))
			defer srv.Close()

			cancelBootstrapIfRefundable(tt.cat, srv.URL, "child-key-123", logging.L("test"))

			if called != tt.wantCalled {
				t.Fatalf("cancel endpoint called = %v, want %v", called, tt.wantCalled)
			}
			if !tt.wantCalled {
				return
			}
			if gotPath != "/api/v1/installer/bootstrap/cancel" {
				t.Errorf("path = %q, want /api/v1/installer/bootstrap/cancel", gotPath)
			}
			if gotSecret != "child-key-123" {
				t.Errorf("enrollmentSecret sent = %q, want %q", gotSecret, "child-key-123")
			}
		})
	}
}

// TestCancelBootstrapIfRefundable_CallFailureIsNonFatal asserts the other
// half of the brief's contract: an error from the cancel call itself (here,
// an unreachable server) must never panic or otherwise propagate — it is
// logged and swallowed. There is nothing to assert on besides "did not
// panic/crash"; logging.L("test") writes through the package's default
// logger, which is safe to use without Init in tests.
func TestCancelBootstrapIfRefundable_CallFailureIsNonFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	srv.Close() // immediately unreachable

	cancelBootstrapIfRefundable(catAuth, srv.URL, "child-key-123", logging.L("test"))
}

// TestRunBootstrap_CancelsSlotOn4xxEnrollRejection is an end-to-end check of
// the hook wiring itself: runBootstrap installs cancelBootstrapOnEnrollFailure
// around its enrollDevice call, and a 4xx from /agents/enroll must reach
// /installer/bootstrap/cancel carrying the redeemed child enrollment KEY —
// NOT the response's `enrollmentSecret`, which the server cannot resolve
// against enrollment_keys.key (that mix-up made the refund a silent no-op in
// production). The mocked redeem response therefore returns two distinct
// values so the assertion below actually discriminates between them. The
// hook must also be cleared again once enrollDevice's failure path
// (enrollError -> osExit) unwinds.
func TestRunBootstrap_CancelsSlotOn4xxEnrollRejection(t *testing.T) {
	var cancelCalled bool
	var cancelCredential string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/installer/bootstrap", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"serverUrl":"","enrollmentKey":"child-key-abc","enrollmentSecret":"child-secret-xyz","siteId":"site1"}`))
	})
	mux.HandleFunc("/api/v1/agents/enroll", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"enrollment key not recognized"}`))
	})
	mux.HandleFunc("/api/v1/installer/bootstrap/cancel", func(w http.ResponseWriter, r *http.Request) {
		cancelCalled = true
		var body struct {
			EnrollmentSecret string `json:"enrollmentSecret"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		cancelCredential = body.EnrollmentSecret
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"refunded":true}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	dir := t.TempDir()
	origCfg, origData, origQuiet := cfgFile, bootstrapInstallData, quietEnroll
	t.Cleanup(func() { cfgFile, bootstrapInstallData, quietEnroll = origCfg, origData, origQuiet })
	cfgFile, quietEnroll = filepath.Join(dir, "agent.yaml"), true
	bootstrapInstallData = `C:\dl\nu-agent.msi|TESTTOKEN1|` + srv.URL

	origExit := osExit
	var exitCode int
	osExit = func(code int) {
		exitCode = code
		panic("test exit") // unwind so the deferred assertions below run
	}
	t.Cleanup(func() { osExit = origExit })

	defer func() {
		_ = recover() // swallow the test-exit panic
		if !cancelCalled {
			t.Fatal("cancel endpoint was not called after a 4xx enroll rejection")
		}
		if cancelCredential != "child-key-abc" {
			t.Fatalf("cancel body enrollmentSecret = %q, want %q (the redeemed child enrollment KEY, not the response's enrollmentSecret %q)",
				cancelCredential, "child-key-abc", "child-secret-xyz")
		}
		if exitCode != catAuth.exitCode() {
			t.Fatalf("exit code = %d, want %d (catAuth)", exitCode, catAuth.exitCode())
		}
		if cancelBootstrapOnEnrollFailure != nil {
			t.Fatal("cancelBootstrapOnEnrollFailure hook was not cleared after enrollDevice's failure path unwound")
		}
	}()

	runBootstrap()
}
