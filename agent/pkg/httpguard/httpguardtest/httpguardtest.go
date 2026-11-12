// Package httpguardtest checks, from tests, how an agent HTTP client handles a
// redirect while it carries the agent credential. Probe never touches the
// network: it drives a copy of the client whose transport answers locally.
package httpguardtest

import (
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

const (
	// Origin is the host the probe request starts on.
	Origin = "https://api.example.test"
	// Token is the bearer credential the probe request carries.
	Token = "Bearer probe-credential"

	startPath = "/start"
)

// OffHostTargets are redirect targets that leave the original host or drop
// from https to http. A client that carries the agent credential must not
// send a request to any of them.
var OffHostTargets = []string{
	"https://other.example.test/next",
	"https://sub.api.example.test/next",
	"http://api.example.test/next",
}

// Result is what a Probe observed.
type Result struct {
	// TargetReached is true when the client sent a request to the redirect
	// target.
	TargetReached bool
	// TargetAuthorization is the Authorization header that request carried.
	TargetAuthorization string
	// Err is the error client.Do returned.
	Err error
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func response(r *http.Request, status int, header http.Header) *http.Response {
	if header == nil {
		header = http.Header{}
	}
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader("")),
		Request:    r,
	}
}

// Probe sends POST Origin+"/start" with the Token credential through a copy
// of client. The copy keeps the client's redirect policy and timeout; its
// transport answers the first request with 307 Temporary Redirect to target,
// and answers target with 200.
func Probe(client *http.Client, target string) Result {
	var (
		mu  sync.Mutex
		res Result
	)
	probe := *client
	probe.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Body != nil {
			_, _ = io.Copy(io.Discard, r.Body)
			_ = r.Body.Close()
		}
		if r.URL.String() == Origin+startPath {
			return response(r, http.StatusTemporaryRedirect, http.Header{"Location": {target}}), nil
		}
		if r.URL.String() == target {
			mu.Lock()
			res.TargetReached = true
			res.TargetAuthorization = r.Header.Get("Authorization")
			mu.Unlock()
		}
		return response(r, http.StatusOK, nil), nil
	})
	req, err := http.NewRequest(http.MethodPost, Origin+startPath, strings.NewReader(`{"probe":true}`))
	if err != nil {
		return Result{Err: err}
	}
	req.Header.Set("Authorization", Token)
	resp, err := probe.Do(req)
	if resp != nil {
		_ = resp.Body.Close()
	}
	mu.Lock()
	defer mu.Unlock()
	res.Err = err
	return res
}

// RequireNoOffHostRedirect fails t when client sends a request to any of the
// OffHostTargets after the server redirects there.
func RequireNoOffHostRedirect(t testing.TB, client *http.Client) {
	t.Helper()
	if client == nil {
		t.Fatal("client is nil")
	}
	for _, target := range OffHostTargets {
		if res := Probe(client, target); res.TargetReached {
			t.Errorf("redirect to %s was followed (Authorization at target: %q)", target, res.TargetAuthorization)
		}
	}
}

// RequireSameHostRedirectsOnly is RequireNoOffHostRedirect plus the other half
// of the shared policy: the client reports an error for an off-host redirect,
// and it still follows a redirect to another path on the same host, keeping
// the credential.
func RequireSameHostRedirectsOnly(t testing.TB, client *http.Client) {
	t.Helper()
	RequireNoOffHostRedirect(t, client)
	for _, target := range OffHostTargets {
		if res := Probe(client, target); res.Err == nil {
			t.Errorf("redirect to %s returned no error", target)
		}
	}
	res := Probe(client, Origin+"/next")
	if res.Err != nil || !res.TargetReached {
		t.Errorf("same-host redirect was not followed: reached=%v err=%v", res.TargetReached, res.Err)
	}
	if res.TargetAuthorization != Token {
		t.Errorf("same-host redirect carried Authorization %q, want the original credential", res.TargetAuthorization)
	}
}
