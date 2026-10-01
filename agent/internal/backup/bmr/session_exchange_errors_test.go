package bmr

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// #7649: a wrong-but-valid https:// server URL used to surface every
// failure as ErrCodeInvalid or an opaque error, and the console printed
// "That code did not work" for all of them. ExchangeRecoveryCode must only
// report ErrCodeInvalid for the Breeze rejection shape ({"error":
// "code_invalid"} on 400/404); a transport failure is a
// *ServerUnreachableError and a response that is not from a Breeze recovery
// endpoint is an *UnexpectedServerResponseError.
func TestExchangeRecoveryCode_ClassifiesFailures(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		contentType string
		body        string
		check       func(t *testing.T, err error)
	}{
		{
			name: "breeze 404 code_invalid is a rejected code", status: 404,
			contentType: "application/json", body: `{"error":"code_invalid"}`,
			check: func(t *testing.T, err error) {
				if !errors.Is(err, ErrCodeInvalid) {
					t.Fatalf("err = %v, want ErrCodeInvalid", err)
				}
			},
		},
		{
			name: "breeze 400 code_invalid (malformed code) is a rejected code", status: 400,
			contentType: "application/json", body: `{"error":"code_invalid"}`,
			check: func(t *testing.T, err error) {
				if !errors.Is(err, ErrCodeInvalid) {
					t.Fatalf("err = %v, want ErrCodeInvalid", err)
				}
			},
		},
		{
			name: "breeze zValidator 400 (over-long code) is a rejected code", status: 400,
			contentType: "application/json", body: `{"success":false,"error":{"issues":[{"code":"too_big"}],"name":"ZodError"}}`,
			check: func(t *testing.T, err error) {
				if !errors.Is(err, ErrCodeInvalid) {
					t.Fatalf("err = %v, want ErrCodeInvalid", err)
				}
			},
		},
		{
			name: "some other JSON API's 400 is not a rejected code", status: 400,
			contentType: "application/json", body: `{"error":"missing field"}`,
			check: func(t *testing.T, err error) {
				if err == nil || errors.Is(err, ErrCodeInvalid) {
					t.Fatalf("err = %v, must not be ErrCodeInvalid", err)
				}
			},
		},
		{
			name: "HTML 400 from some other web server is not a rejected code", status: 400,
			contentType: "text/html", body: "<html>Bad Request</html>",
			check: func(t *testing.T, err error) {
				var ue *UnexpectedServerResponseError
				if errors.Is(err, ErrCodeInvalid) || !errors.As(err, &ue) {
					t.Fatalf("err = %v (%T), want *UnexpectedServerResponseError", err, err)
				}
			},
		},
		{
			name: "plain-text 404 from some other web server is not a rejected code", status: 404,
			contentType: "text/plain; charset=utf-8", body: "404 page not found\n",
			check: func(t *testing.T, err error) {
				if errors.Is(err, ErrCodeInvalid) {
					t.Fatalf("err = %v, must not be ErrCodeInvalid", err)
				}
				var ue *UnexpectedServerResponseError
				if !errors.As(err, &ue) || ue.StatusCode != 404 {
					t.Fatalf("err = %v (%T), want *UnexpectedServerResponseError{404}", err, err)
				}
			},
		},
		{
			name: "JSON 404 with a different error is not a rejected code", status: 404,
			contentType: "application/json", body: `{"error":"Not Found"}`,
			check: func(t *testing.T, err error) {
				var ue *UnexpectedServerResponseError
				if errors.Is(err, ErrCodeInvalid) || !errors.As(err, &ue) {
					t.Fatalf("err = %v (%T), want *UnexpectedServerResponseError", err, err)
				}
			},
		},
		{
			name: "HTML 200 (captive portal / marketing site) is not a Breeze response", status: 200,
			contentType: "text/html", body: "<html><body>Welcome</body></html>",
			check: func(t *testing.T, err error) {
				var ue *UnexpectedServerResponseError
				if !errors.As(err, &ue) || ue.StatusCode != 200 {
					t.Fatalf("err = %v (%T), want *UnexpectedServerResponseError{200}", err, err)
				}
			},
		},
		{
			name: "HTML 502 from a proxy is not a Breeze response", status: 502,
			contentType: "text/html", body: "<html>Bad Gateway</html>",
			check: func(t *testing.T, err error) {
				var ue *UnexpectedServerResponseError
				if !errors.As(err, &ue) || ue.StatusCode != 502 {
					t.Fatalf("err = %v (%T), want *UnexpectedServerResponseError{502}", err, err)
				}
			},
		},
		{
			name: "breeze JSON 429 stays a plain server error", status: 429,
			contentType: "application/json", body: `{"error":"Too many requests"}`,
			check: func(t *testing.T, err error) {
				var ue *UnexpectedServerResponseError
				var su *ServerUnreachableError
				if err == nil || errors.Is(err, ErrCodeInvalid) || errors.As(err, &ue) || errors.As(err, &su) {
					t.Fatalf("err = %v (%T), want a plain server error", err, err)
				}
			},
		},
		{
			name: "breeze JSON 409 stays a negotiation refusal", status: 409,
			contentType: "application/json", body: `{"error":"helper_version_too_old","message":"too old"}`,
			check: func(t *testing.T, err error) {
				var neg *RecoveryNegotiationError
				if !errors.As(err, &neg) || neg.Code != "helper_version_too_old" {
					t.Fatalf("err = %v (%T), want RecoveryNegotiationError helper_version_too_old", err, err)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.contentType)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			_, _, err := ExchangeRecoveryCode(context.Background(), srv.URL, "ABC-DEF-GHJ", "")
			tc.check(t, err)
		})
	}
}

func TestExchangeRecoveryCode_ConnectionRefusedIsServerUnreachable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	_, _, err = ExchangeRecoveryCode(context.Background(), "http://"+addr, "ABC-DEF-GHJ", "")
	var su *ServerUnreachableError
	if !errors.As(err, &su) {
		t.Fatalf("err = %v (%T), want *ServerUnreachableError", err, err)
	}
	if su.Host != addr {
		t.Fatalf("Host = %q, want %q", su.Host, addr)
	}
	if errors.Is(err, ErrCodeInvalid) {
		t.Fatalf("connection refused must not read as ErrCodeInvalid")
	}
}

func TestExchangeRecoveryCode_UntrustedTLSIsServerUnreachable(t *testing.T) {
	// httptest's TLS server uses a self-signed cert the default client does
	// not trust — the same handshake failure a wrong host's certificate
	// produces on the recovery media.
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("handler reached despite an untrusted certificate")
	}))
	defer srv.Close()

	_, _, err := ExchangeRecoveryCode(context.Background(), srv.URL, "ABC-DEF-GHJ", "")
	var su *ServerUnreachableError
	if !errors.As(err, &su) {
		t.Fatalf("err = %v (%T), want *ServerUnreachableError", err, err)
	}
}

func TestExchangeRecoveryCode_CancelledContextIsNotServerUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := ExchangeRecoveryCode(ctx, srv.URL, "ABC-DEF-GHJ", "")
	var su *ServerUnreachableError
	if err == nil || errors.As(err, &su) {
		t.Fatalf("err = %v (%T), want a non-ServerUnreachable error for a cancelled context", err, err)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want it to wrap context.Canceled", err)
	}
}

func TestVerifyPinnedServerCert_MismatchIsErrServerCertPinMismatch(t *testing.T) {
	SetExpectedServerCertPin("bm90LWEtcmVhbC1waW4=")
	defer SetExpectedServerCertPin("")
	if err := verifyPinnedServerCert(nil, nil); !errors.Is(err, ErrServerCertPinMismatch) {
		t.Fatalf("no verified chain: err = %v, want ErrServerCertPinMismatch", err)
	}
}
