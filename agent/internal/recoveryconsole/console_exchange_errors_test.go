package recoveryconsole

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
)

// unreachable builds the error bmr.ExchangeRecoveryCode returns when the
// HTTP request never got a response: a *bmr.ServerUnreachableError wrapping
// the *url.Error net/http produces.
func unreachable(host string, cause error) error {
	return &bmr.ServerUnreachableError{
		Host: host,
		Err:  &url.Error{Op: "Post", URL: "https://" + host + "/api/v1/backup/bmr/recover/exchange", Err: cause},
	}
}

func TestClassifyExchangeError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want exchangeFailure
	}{
		{"rejected code", bmr.ErrCodeInvalid, failureCodeRejected},
		{"wrapped rejected code", fmt.Errorf("exchange: %w", bmr.ErrCodeInvalid), failureCodeRejected},
		{"dns", unreachable("wrong.example", &net.DNSError{Err: "no such host", Name: "wrong.example", IsNotFound: true}), failureServerUnreachable},
		{"connection refused", unreachable("wrong.example", &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}}), failureServerUnreachable},
		{"tls untrusted", unreachable("wrong.example", x509.UnknownAuthorityError{}), failureServerUnreachable},
		{"not a breeze server", &bmr.UnexpectedServerResponseError{Host: "wrong.example", StatusCode: 404, ContentType: "text/html"}, failureNotBreezeServer},
		{"negotiation refusal", &bmr.RecoveryNegotiationError{Code: "helper_version_too_old", Message: "too old"}, failureRefused},
		{"breeze rate limit", errors.New("bmr: exchange failed: Rate limit exceeded. Please wait before retrying."), failureServerError},
		{"cancelled context", fmt.Errorf("bmr: exchange request failed: %w", context.Canceled), failureServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyExchangeError(tc.err); got != tc.want {
				t.Fatalf("classifyExchangeError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestUnreachableReason(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"dns not found", unreachable("wrong.example", &net.DNSError{Err: "no such host", Name: "wrong.example", IsNotFound: true}), "server name not found"},
		{"dns other", unreachable("wrong.example", &net.DNSError{Err: "server misbehaving", Name: "wrong.example"}), "DNS lookup failed"},
		{"connection refused", unreachable("wrong.example", &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}}), "connection refused"},
		{"host unreachable", unreachable("wrong.example", &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: syscall.EHOSTUNREACH}}), "no route to the server"},
		{"network unreachable", unreachable("wrong.example", &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ENETUNREACH}}), "no route to the server"},
		{"timeout", unreachable("wrong.example", timeoutErr{}), "timed out"},
		{"tls untrusted", unreachable("wrong.example", x509.UnknownAuthorityError{}), "TLS certificate"},
		{"tls hostname", unreachable("wrong.example", x509.HostnameError{Certificate: &x509.Certificate{}, Host: "wrong.example"}), "TLS certificate"},
		{"pin mismatch", unreachable("wrong.example", fmt.Errorf("%w: no match", bmr.ErrServerCertPinMismatch)), "pinned"},
		{"other", unreachable("wrong.example", errors.New("something odd")), "something odd"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := unreachableReason(tc.err)
			if !strings.Contains(got, tc.want) {
				t.Fatalf("unreachableReason() = %q, want it to contain %q", got, tc.want)
			}
		})
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

// #7649 regression: a wrong-but-valid https:// URL made every attempt fail
// with "That code did not work", spent all three attempts, and exited. A
// transport failure must print the real reason, not count as an attempt,
// and send the operator back to the server prompt.
func TestConnect_UnreachableServerReturnsToServerPromptWithoutSpendingAttempts(t *testing.T) {
	const good = "https://breeze.example"
	var calls []string
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			calls = append(calls, server)
			if server != good {
				return "", nil, unreachable("wrong.example", &net.DNSError{Err: "no such host", Name: "wrong.example", IsNotFound: true})
			}
			return happyExchange(t)(ctx, server, code)
		},
	}
	// More wrong-server rounds than maxCodeAttempts, to prove none of them
	// count against the code-attempt limit.
	var answers []string
	for i := 0; i < maxCodeAttempts+1; i++ {
		answers = append(answers, "https://wrong.example", "abc-def-ghj")
	}
	answers = append(answers, good, "abc-def-ghj")
	io := &fakeIO{Answers: answers}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}

	server, token, _, err := c.connect(context.Background(), false, Answers{})
	if err != nil {
		t.Fatalf("connect() error = %v\ntranscript:\n%s", err, io.transcript.String())
	}
	if server != good || token != "tok-1" {
		t.Fatalf("connect() = (%q, %q), want (%q, tok-1)", server, token, good)
	}
	if len(calls) != maxCodeAttempts+2 {
		t.Fatalf("exchange calls = %d, want %d", len(calls), maxCodeAttempts+2)
	}
	transcript := io.transcript.String()
	if strings.Contains(transcript, "That code did not work") {
		t.Fatalf("transcript blames the code for a network failure:\n%s", transcript)
	}
	if !strings.Contains(transcript, "Could not reach wrong.example: server name not found") {
		t.Fatalf("transcript missing the real reason:\n%s", transcript)
	}
	if got := strings.Count(transcript, "Breeze server URL"); got != maxCodeAttempts+2 {
		t.Fatalf("server prompts = %d, want %d (one per wrong-server round + the good one)\n%s", got, maxCodeAttempts+2, transcript)
	}
}

func TestConnect_NonBreezeServerReturnsToServerPrompt(t *testing.T) {
	const good = "https://breeze.example"
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			if server != good {
				return "", nil, &bmr.UnexpectedServerResponseError{Host: "www.example", StatusCode: 404, ContentType: "text/html"}
			}
			return happyExchange(t)(ctx, server, code)
		},
	}
	io := &fakeIO{Answers: []string{"https://www.example", "abc-def-ghj", good, "abc-def-ghj"}}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}

	server, _, _, err := c.connect(context.Background(), false, Answers{})
	if err != nil || server != good {
		t.Fatalf("connect() = (%q, %v), want (%q, nil)", server, err, good)
	}
	transcript := io.transcript.String()
	if strings.Contains(transcript, "That code did not work") {
		t.Fatalf("transcript blames the code for a non-Breeze server:\n%s", transcript)
	}
	if !strings.Contains(transcript, "www.example answered, but not as a Breeze recovery server (HTTP 404") {
		t.Fatalf("transcript missing the not-Breeze message:\n%s", transcript)
	}
}

func TestConnect_RejectedCodesStillLimitedToThreeAttempts(t *testing.T) {
	calls := 0
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			calls++
			return "", nil, bmr.ErrCodeInvalid
		},
	}
	io := &fakeIO{Answers: []string{"https://breeze.example", "a", "b", "c", "d"}}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}

	_, _, _, err := c.connect(context.Background(), false, Answers{})
	if err == nil || !strings.Contains(err.Error(), "too many invalid recovery codes") {
		t.Fatalf("connect() error = %v, want too many invalid recovery codes", err)
	}
	if calls != maxCodeAttempts {
		t.Fatalf("exchange calls = %d, want %d", calls, maxCodeAttempts)
	}
	if got := strings.Count(io.transcript.String(), "That code did not work"); got != maxCodeAttempts {
		t.Fatalf(`"That code did not work" printed %d times, want %d`, got, maxCodeAttempts)
	}
}

// A rejected code before a server re-entry still counts: the attempt limit
// is per console run, not per server URL.
func TestConnect_RejectionsSurviveServerReentry(t *testing.T) {
	n := 0
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			n++
			if n == 2 {
				return "", nil, unreachable("breeze.example", &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}})
			}
			return "", nil, bmr.ErrCodeInvalid
		},
	}
	io := &fakeIO{Answers: []string{"https://breeze.example", "a", "b", "https://breeze.example", "c", "d", "e"}}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}

	_, _, _, err := c.connect(context.Background(), false, Answers{})
	if err == nil || !strings.Contains(err.Error(), "too many invalid recovery codes") {
		t.Fatalf("connect() error = %v, want too many invalid recovery codes", err)
	}
	if n != maxCodeAttempts+1 {
		t.Fatalf("exchange calls = %d, want %d (3 rejections + 1 unreachable)", n, maxCodeAttempts+1)
	}
}

// A Breeze server error that is not a verdict on the code (rate limit, 5xx)
// is shown as what it is, does not count, and re-prompts for the code.
func TestConnect_ServerErrorIsNotBlamedOnTheCode(t *testing.T) {
	n := 0
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			n++
			if n < maxCodeAttempts {
				return "", nil, errors.New("bmr: exchange failed: Rate limit exceeded. Please wait before retrying.")
			}
			return happyExchange(t)(ctx, server, code)
		},
	}
	var answers = []string{"https://breeze.example"}
	for i := 0; i < maxCodeAttempts; i++ {
		answers = append(answers, "abc-def-ghj")
	}
	io := &fakeIO{Answers: answers}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}

	_, token, _, err := c.connect(context.Background(), false, Answers{})
	if err != nil || token != "tok-1" {
		t.Fatalf("connect() = (%q, %v), want (tok-1, nil)\n%s", token, err, io.transcript.String())
	}
	transcript := io.transcript.String()
	if strings.Contains(transcript, "That code did not work") {
		t.Fatalf("transcript blames the code for a server error:\n%s", transcript)
	}
	if !strings.Contains(transcript, "Rate limit exceeded") {
		t.Fatalf("transcript missing the server's error:\n%s", transcript)
	}
}

func TestConnect_EmptyCodeIsNotSentOrCounted(t *testing.T) {
	calls := 0
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			calls++
			return happyExchange(t)(ctx, server, code)
		},
	}
	io := &fakeIO{Answers: []string{"https://breeze.example", "", "  ", "", "", "abc-def-ghj"}}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}
	if _, _, _, err := c.connect(context.Background(), false, Answers{}); err != nil {
		t.Fatalf("connect() error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("exchange calls = %d, want 1", calls)
	}
}

// CI mode never prompts, so an unreachable server is a terminal error that
// carries the real reason.
func TestConnect_CIUnreachableFailsWithReason(t *testing.T) {
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			return "", nil, unreachable("wrong.example", x509.UnknownAuthorityError{})
		},
	}
	io := &fakeIO{FailReadLine: true}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}
	_, _, _, err := c.connect(context.Background(), true, Answers{Server: "https://wrong.example", Code: "abc"})
	var su *bmr.ServerUnreachableError
	if err == nil || !errors.As(err, &su) {
		t.Fatalf("connect() error = %v, want a *bmr.ServerUnreachableError", err)
	}
	if io.readLineCalls != 0 {
		t.Fatalf("CI mode prompted %d times", io.readLineCalls)
	}
}

// Review finding: a persistent non-verdict server error (a JSON API at the
// wrong URL answering 401/500, or a Breeze outage) must not re-prompt the
// code forever — after maxCodeAttempts in a row it returns to the server
// prompt, still without counting any attempt.
func TestConnect_PersistentServerErrorReturnsToServerPrompt(t *testing.T) {
	const good = "https://breeze.example"
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			if server != good {
				return "", nil, errors.New("bmr: exchange failed: Unauthorized")
			}
			return happyExchange(t)(ctx, server, code)
		},
	}
	answers := []string{"https://other-api.example"}
	for i := 0; i < maxCodeAttempts; i++ {
		answers = append(answers, "abc-def-ghj")
	}
	answers = append(answers, good, "abc-def-ghj")
	io := &fakeIO{Answers: answers}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}

	server, _, _, err := c.connect(context.Background(), false, Answers{})
	if err != nil || server != good {
		t.Fatalf("connect() = (%q, %v), want (%q, nil)\n%s", server, err, good, io.transcript.String())
	}
	if c.codeRejections != 0 {
		t.Fatalf("codeRejections = %d, want 0", c.codeRejections)
	}
}

func TestConnect_TimeoutAfterSendWarnsTheCodeMayBeUsed(t *testing.T) {
	const good = "https://breeze.example"
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			if server != good {
				return "", nil, unreachable("slow.example", timeoutErr{})
			}
			return happyExchange(t)(ctx, server, code)
		},
	}
	io := &fakeIO{Answers: []string{"https://slow.example", "abc-def-ghj", good, "abc-def-ghj"}}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}
	if _, _, _, err := c.connect(context.Background(), false, Answers{}); err != nil {
		t.Fatalf("connect() error = %v", err)
	}
	transcript := io.transcript.String()
	if !strings.Contains(transcript, "may have reached the server") {
		t.Fatalf("transcript missing the code-may-be-used notice:\n%s", transcript)
	}
	if strings.Contains(transcript, "code was not sent") {
		t.Fatalf("transcript claims the code was not sent after a timeout:\n%s", transcript)
	}
}

func TestConnect_ProxyErrorPageSaysServerMayBeDown(t *testing.T) {
	const good = "https://breeze.example"
	deps := &fakeDeps{
		exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
			if server != good {
				return "", nil, &bmr.UnexpectedServerResponseError{Host: "breeze.example:8443", StatusCode: 502, ContentType: "text/html"}
			}
			return happyExchange(t)(ctx, server, code)
		},
	}
	io := &fakeIO{Answers: []string{"https://breeze.example:8443", "abc-def-ghj", good, "abc-def-ghj"}}
	c := &Console{IO: io, Deps: deps.build("0.111.1")}
	if _, _, _, err := c.connect(context.Background(), false, Answers{}); err != nil {
		t.Fatalf("connect() error = %v", err)
	}
	transcript := io.transcript.String()
	for _, want := range []string{"may be down or restarting", "may have reached the server"} {
		if !strings.Contains(transcript, want) {
			t.Fatalf("transcript missing %q:\n%s", want, transcript)
		}
	}
}

func TestFailedBeforeSending(t *testing.T) {
	refused := &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}}
	reset := &net.OpError{Op: "read", Net: "tcp", Err: &os.SyscallError{Syscall: "read", Err: syscall.ECONNRESET}}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"dns", unreachable("x", &net.DNSError{Err: "no such host", Name: "x", IsNotFound: true}), true},
		{"dial refused", unreachable("x", refused), true},
		{"tls untrusted", unreachable("x", x509.UnknownAuthorityError{}), true},
		{"pin mismatch", unreachable("x", fmt.Errorf("%w: no match", bmr.ErrServerCertPinMismatch)), true},
		{"read reset after send", unreachable("x", reset), false},
		{"timeout", unreachable("x", timeoutErr{}), false},
		{"unknown", unreachable("x", errors.New("EOF")), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := failedBeforeSending(tc.err); got != tc.want {
				t.Fatalf("failedBeforeSending() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestUnreachableReason_ExpiredCertPointsAtTheClock(t *testing.T) {
	err := unreachable("x", x509.CertificateInvalidError{Cert: &x509.Certificate{}, Reason: x509.Expired})
	if got := unreachableReason(err); !strings.Contains(got, "date and time") {
		t.Fatalf("unreachableReason() = %q, want it to point at the clock", got)
	}
}
