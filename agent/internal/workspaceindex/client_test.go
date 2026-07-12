package workspaceindex

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/secmem"
)

func newHTTPTestEndpoint(handler http.Handler, hostname string) (string, *http.Client) {
	return "http://" + hostname, &http.Client{Transport: handlerRoundTripper{handler: handler}}
}

type handlerRoundTripper struct{ handler http.Handler }

func (rt handlerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	recorder := httptest.NewRecorder()
	rt.handler.ServeHTTP(recorder, req)
	return recorder.Result(), nil
}

func newTestClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()

	serverURL, httpClient := newHTTPTestEndpoint(handler, "server.test")
	token := secmem.NewSecureString("agent-secret")
	t.Cleanup(token.Zero)

	return NewClient(ClientConfig{
		ServerURL:  serverURL,
		AuthToken:  token,
		HTTPClient: httpClient,
	})
}

func TestFetchConfigSendsAuthorizationAndDecodesWireShape(t *testing.T) {
	startedAt := time.Date(2026, time.July, 12, 12, 30, 0, 0, time.UTC)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/workspace/agent/crawl-config" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer agent-secret" {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"enabled":true,
			"pollIntervalSeconds":300,
			"limits":{"maxBatchBytes":921600,"maxBatchEntries":2000,"walkOpsPerSecond":200},
			"sources":[{"id":"source-1","kind":"smb_share","rootPath":"share","cadenceMinutes":720,"excludeGlobs":["tmp/**"],"hasCredential":true,"lastCompleteRunAt":null,"activeRun":{"runId":"run-1","startedAt":"`+startedAt.Format(time.RFC3339)+`","cursor":"dir/file"},"watch":false}]
		}`)
	}))

	config, err := client.FetchConfig(context.Background())
	if err != nil {
		t.Fatalf("FetchConfig: %v", err)
	}
	if !config.Enabled || config.PollIntervalSeconds != 300 || config.Limits.MaxBatchEntries != 2000 {
		t.Fatalf("unexpected config: %+v", config)
	}
	if len(config.Sources) != 1 || config.Sources[0].ActiveRun == nil || config.Sources[0].ActiveRun.RunID != "run-1" {
		t.Fatalf("unexpected sources: %+v", config.Sources)
	}
}

func TestPostBatchGzipRoundTrip(t *testing.T) {
	mtime := time.Date(2026, time.July, 12, 13, 0, 0, 0, time.UTC)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/workspace/agent/runs/run-1/batch" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Content-Encoding"); got != "gzip" {
			t.Errorf("Content-Encoding = %q, want gzip", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}

		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Errorf("gzip.NewReader: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		defer zr.Close()
		var payload struct {
			Cursor  string  `json:"cursor"`
			Entries []Entry `json:"entries"`
		}
		if err := json.NewDecoder(zr).Decode(&payload); err != nil {
			t.Errorf("decode batch: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if payload.Cursor != "dir/file.txt" || len(payload.Entries) != 1 || payload.Entries[0].RelPath != "dir/file.txt" {
			t.Errorf("unexpected payload: %+v", payload)
		}
		w.WriteHeader(http.StatusAccepted)
	}))

	err := client.PostBatch(context.Background(), "run-1", "dir/file.txt", []Entry{{
		RelPath: "dir/file.txt", ParentPath: "dir", Name: "file.txt", Size: 42,
		Mtime: mtime, Attrs: map[string]any{},
	}})
	if err != nil {
		t.Fatalf("PostBatch: %v", err)
	}
}

func TestSentinelStatusMappings(t *testing.T) {
	tests := []struct {
		name   string
		status int
		call   func(context.Context, *Client) error
		want   error
	}{
		{
			name:   "module absent",
			status: http.StatusNotFound,
			call: func(ctx context.Context, client *Client) error {
				_, err := client.FetchConfig(ctx)
				return err
			},
			want: ErrModuleAbsent,
		},
		{
			name:   "run conflict",
			status: http.StatusConflict,
			call: func(ctx context.Context, client *Client) error {
				_, err := client.StartRun(ctx, "source-1")
				return err
			},
			want: ErrRunConflict,
		},
		{
			name:   "batch too large",
			status: http.StatusRequestEntityTooLarge,
			call: func(ctx context.Context, client *Client) error {
				return client.PostBatch(ctx, "run-1", "cursor", nil)
			},
			want: ErrBatchTooLarge,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
			}))
			if err := tt.call(context.Background(), client); !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want errors.Is(_, %v)", err, tt.want)
			}
		})
	}
}

func TestRedirectToOtherHostIsRefused(t *testing.T) {
	var attackerHits atomic.Int32
	attackerURL, _ := newHTTPTestEndpoint(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		attackerHits.Add(1)
	}), "attacker.test")

	originURL, originClient := newHTTPTestEndpoint(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, attackerURL, http.StatusTemporaryRedirect)
	}), "origin.test")
	token := secmem.NewSecureString("redirect-secret")
	defer token.Zero()
	client := NewClient(ClientConfig{ServerURL: originURL, AuthToken: token, HTTPClient: originClient})

	_, err := client.FetchConfig(context.Background())
	if err == nil || !strings.Contains(err.Error(), "untrusted host") {
		t.Fatalf("FetchConfig error = %v, want untrusted-host redirect error", err)
	}
	if got := attackerHits.Load(); got != 0 {
		t.Fatalf("redirect target received %d requests, want 0", got)
	}
	if strings.Contains(err.Error(), "redirect-secret") {
		t.Fatalf("redirect error leaked bearer token: %v", err)
	}
}

func TestCredentialRedactsStringAndJSONRepresentations(t *testing.T) {
	credential := Credential{Username: "svc-index", Password: "super-secret"}
	representations := []struct {
		name string
		get  func() string
	}{
		{name: "String", get: func() string { return fmt.Sprintf("%v", credential) }},
		{name: "GoString", get: func() string { return fmt.Sprintf("%#v", credential) }},
		{name: "JSON", get: func() string {
			data, err := json.Marshal(credential)
			if err != nil {
				t.Fatalf("json.Marshal: %v", err)
			}
			return string(data)
		}},
	}

	for _, tt := range representations {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.get(); strings.Contains(got, credential.Password) {
				t.Fatalf("representation leaked password: %q", got)
			}
		})
	}
}
