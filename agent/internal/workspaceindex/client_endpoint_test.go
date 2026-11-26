package workspaceindex

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// endpointRecorder answers every workspace-index call with a minimal success
// body and records the escaped request path, so a test can assert exactly
// where each client method sent its request.
type endpointRecorder struct {
	mu    sync.Mutex
	paths []string
}

func (rec *endpointRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rec.mu.Lock()
	rec.paths = append(rec.paths, r.Method+" "+r.URL.EscapedPath())
	rec.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{}`)
}

func (rec *endpointRecorder) last(t *testing.T) string {
	t.Helper()
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.paths) == 0 {
		t.Fatal("no request reached the server")
	}
	return rec.paths[len(rec.paths)-1]
}

func newEndpointClient(t *testing.T, rec *endpointRecorder, agentID, endpointBase string) *Client {
	t.Helper()
	serverURL, httpClient := newHTTPTestEndpoint(rec, "server.test")
	token := secmem.NewSecureString("agent-secret")
	t.Cleanup(token.Zero)
	return NewClient(ClientConfig{
		ServerURL:    func() string { return serverURL },
		AgentID:      agentID,
		EndpointBase: endpointBase,
		AuthToken:    token,
		HTTPClient:   httpClient,
	})
}

// endpointCalls drives every route the client calls, in one table, so a new
// client method cannot quietly skip the agent-ID path shape.
var endpointCalls = []struct {
	name string
	path string // relative to the endpoint base
	call func(context.Context, *Client) error
}{
	{"FetchConfig", "GET /crawl-config", func(ctx context.Context, c *Client) error {
		_, err := c.FetchConfig(ctx)
		return err
	}},
	{"FetchCredential", "POST /sources/source-1/credential", func(ctx context.Context, c *Client) error {
		cred, err := c.FetchCredential(ctx, "source-1")
		if cred != nil {
			cred.Zero()
		}
		return err
	}},
	{"StartRun", "POST /runs", func(ctx context.Context, c *Client) error {
		_, err := c.StartRun(ctx, "source-1")
		return err
	}},
	{"PostBatch", "POST /runs/run-1/batch", func(ctx context.Context, c *Client) error {
		return c.PostBatch(ctx, "run-1", "a", []Entry{{RelPath: "a"}})
	}},
	{"CompleteRun", "POST /runs/run-1/complete", func(ctx context.Context, c *Client) error {
		return c.CompleteRun(ctx, "run-1", true, Stats{}, "")
	}},
	{"PostEvents", "POST /sources/source-1/events", func(ctx context.Context, c *Client) error {
		return c.PostEvents(ctx, "source-1", nil, []string{"a"})
	}},
}

// #12690 — the server's extension gateway authenticates agent traffic by the
// path segment after /api/v1/workspace/agent/ (it is read as the agent ID). A
// default base without the agent ID made that segment the action name
// ("crawl-config", "runs", "sources"), so every request was a 401.
func TestDefaultEndpointBaseCarriesAgentIDOnEveryRoute(t *testing.T) {
	for _, tc := range endpointCalls {
		t.Run(tc.name, func(t *testing.T) {
			rec := &endpointRecorder{}
			client := newEndpointClient(t, rec, "agent-1", "")
			if err := tc.call(context.Background(), client); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			method, rel, _ := strings.Cut(tc.path, " ")
			want := method + " /api/v1/workspace/agent/agent-1" + rel
			if got := rec.last(t); got != want {
				t.Fatalf("%s request = %q, want %q", tc.name, got, want)
			}
		})
	}
}

// The agent ID is one path segment: anything that would split or rewrite the
// path is escaped rather than allowed to address a different route.
func TestDefaultEndpointBaseEscapesAgentID(t *testing.T) {
	rec := &endpointRecorder{}
	client := newEndpointClient(t, rec, "a/b c", "")
	if _, err := client.FetchConfig(context.Background()); err != nil {
		t.Fatalf("FetchConfig: %v", err)
	}
	if got, want := rec.last(t), "GET /api/v1/workspace/agent/a%2Fb%20c/crawl-config"; got != want {
		t.Fatalf("request = %q, want %q", got, want)
	}
}

// An explicitly configured endpoint_base is used exactly as written: the
// workaround from issue #12690 (a base already carrying the agent ID) must not get the
// ID appended a second time, and a custom base must not be rewritten.
func TestExplicitEndpointBaseIsUsedVerbatim(t *testing.T) {
	cases := []struct {
		name string
		base string
		want string
	}{
		{"workaround base with agent ID", "/api/v1/workspace/agent/agent-1", "GET /api/v1/workspace/agent/agent-1/crawl-config"},
		{"workaround base with trailing slash", "/api/v1/workspace/agent/agent-1/", "GET /api/v1/workspace/agent/agent-1/crawl-config"},
		{"custom base", "/custom/base", "GET /custom/base/crawl-config"},
		{"custom base without leading slash", "custom/base", "GET /custom/base/crawl-config"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := &endpointRecorder{}
			client := newEndpointClient(t, rec, "agent-1", tc.base)
			if _, err := client.FetchConfig(context.Background()); err != nil {
				t.Fatalf("FetchConfig: %v", err)
			}
			if got := rec.last(t); got != tc.want {
				t.Fatalf("request = %q, want %q", got, tc.want)
			}
		})
	}
}

// With no agent ID and no explicit base the client must not fall back to the
// ID-less base: those requests are 401s that land on the shared auth monitor.
// Every route fails by name and nothing reaches the server.
func TestMissingAgentIDFailsByNameWithoutSending(t *testing.T) {
	for _, tc := range endpointCalls {
		t.Run(tc.name, func(t *testing.T) {
			rec := &endpointRecorder{}
			client := newEndpointClient(t, rec, "", "")
			if err := tc.call(context.Background(), client); !errors.Is(err, ErrNoAgentID) {
				t.Fatalf("%s error = %v, want ErrNoAgentID", tc.name, err)
			}
			rec.mu.Lock()
			defer rec.mu.Unlock()
			if len(rec.paths) != 0 {
				t.Fatalf("%s sent %v, want no request", tc.name, rec.paths)
			}
		})
	}
}
