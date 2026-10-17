package workloads

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
)

func hex8(block string) string { return strings.Repeat(block, 8) }

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fakeEngine serves canned responses and records every request line it sees.
type fakeEngine struct {
	mu       sync.Mutex
	requests []string
	routes   map[string]func(w http.ResponseWriter)
	srv      *httptest.Server
}

func newFakeEngine(t *testing.T, routes map[string]func(w http.ResponseWriter)) (*fakeEngine, DialFunc) {
	t.Helper()
	f := &fakeEngine{routes: routes}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.RequestURI()
		f.mu.Lock()
		f.requests = append(f.requests, r.Method+" "+key)
		f.mu.Unlock()
		if h, ok := f.routes[key]; ok {
			h(w)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f, func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", f.srv.Listener.Addr().String())
	}
}

func (f *fakeEngine) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

func serve(body []byte) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}
}

func status(code int) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) { w.WriteHeader(code) }
}

func dockerRoutes(t *testing.T) map[string]func(w http.ResponseWriter) {
	return map[string]func(w http.ResponseWriter){
		"/_ping":                 serve([]byte("OK")),
		"/version":               serve(fixture(t, "docker_version.json")),
		"/containers/json?all=1": serve(fixture(t, "docker_containers.json")),
		"/images/json":           serve(fixture(t, "docker_images.json")),
	}
}

func byName(ws []Workload) map[string]Workload {
	m := map[string]Workload{}
	for _, w := range ws {
		m[w.Name] = w
	}
	return m
}

func val(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestDockerDetectAndCollectFixture(t *testing.T) {
	eng, dial := newFakeEngine(t, dockerRoutes(t))
	d := newEngineDriver(RuntimeDocker, dial)
	det := d.Detect(context.Background())
	if det.State != DetectionPresent || det.Version != "27.1.1" || det.Reason != "" {
		t.Fatalf("detection = %+v", det)
	}
	res := d.Collect(context.Background(), det)
	if res.Collection != CollectionOK || !res.Complete || res.ObservedCount != 5 || len(res.Workloads) != 5 || res.Error != "" {
		t.Fatalf("result = %+v", res)
	}

	// Running first, then newest first: web, cache, pinned, builder, old-web.
	var order []string
	for _, w := range res.Workloads {
		order = append(order, w.Name)
	}
	if want := []string{"shop-web-1", "cache", "pinned", "builder", "old-web"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}

	ws := byName(res.Workloads)
	d1, d2 := "sha256:"+hex8("d1d1d1d1"), "sha256:"+hex8("d2d2d2d2")
	web := ws["shop-web-1"]
	checks := []struct{ name, got, want string }{
		{"web id", web.WorkloadID, hex8("1a1a1a1a")},
		{"web kind", web.Kind, KindContainer},
		{"web state", web.State, StateRunning},
		{"web raw", val(web.RawState), "running"},
		{"web ref", val(web.ImageRef), "nginx:1.27"},
		{"web repo", val(web.ImageRepository), "docker.io/library/nginx"},
		{"web tag", val(web.ImageTag), "1.27"},
		{"web digest (multi-arch, repo-matched)", val(web.ImageDigest), d1},
		{"web image id", val(web.ImageID), "sha256:" + hex8("a0a0a0a0")},
		{"web project", val(web.ComposeProject), "shop"},
		{"web service", val(web.ComposeService), "web"},
		{"web working dir", val(web.ComposeWorkingDir), "/srv/shop"},
		{"web created", val(web.RuntimeCreatedAt), "2025-10-01T08:30:00Z"},
		{"web started", val(web.StartedAt), "<nil>"},
		{"web restart policy", val(web.RestartPolicy), "<nil>"},
		{"redis ref", val(ws["cache"].ImageRef), "redis"},
		{"redis repo", val(ws["cache"].ImageRepository), "docker.io/library/redis"},
		{"redis tag", val(ws["cache"].ImageTag), "latest"},
		{"redis digest", val(ws["cache"].ImageDigest), "sha256:" + hex8("f4f4f4f4")},
		{"pinned tag", val(ws["pinned"].ImageTag), "<nil>"},
		{"pinned repo", val(ws["pinned"].ImageRepository), "ghcr.io/o/r"},
		{"pinned digest", val(ws["pinned"].ImageDigest), "sha256:" + hex8("e3e3e3e3")},
		{"pinned state", ws["pinned"].State, StateRestarting},
		{"pinned project", val(ws["pinned"].ComposeProject), "tools"},
		{"local build digest is null", val(ws["builder"].ImageDigest), "<nil>"},
		{"local build tag", val(ws["builder"].ImageTag), "dev"},
		{"first name wins", ws["builder"].Name, "builder"},
		{"exited is stopped", ws["builder"].State, StateStopped},
		{"exited raw", val(ws["builder"].RawState), "exited"},
		{"id-ref recovered from image tags", val(ws["old-web"].ImageRef), "nginx:1.27"},
		{"id-ref digest", val(ws["old-web"].ImageDigest), d1},
		{"dead is stopped", ws["old-web"].State, StateStopped},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
	// The mirror repository resolves to its own digest, not the Docker Hub one.
	if got := PickRepoDigest("registry.example.com/mirror/nginx", []string{
		"nginx@" + d1, "registry.example.com/mirror/nginx@" + d2}); got != d2 {
		t.Errorf("mirror digest = %q", got)
	}

	// Every request was a GET on the allowlist, in a bounded number of calls.
	want := []string{"GET /_ping", "GET /version", "GET /containers/json?all=1", "GET /images/json"}
	if got := eng.seen(); !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
}

// Env, command, mounts, ports, networks and non-compose labels are present in
// the fixture; none of them may reach the serialized report.
func TestDockerReportNeverContainsSensitiveFixtureValues(t *testing.T) {
	_, dial := newFakeEngine(t, dockerRoutes(t))
	d := newEngineDriver(RuntimeDocker, dial)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	raw, err := json.Marshal(res.Workloads)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"FIXTURE_CMD_SECRET", "FIXTURE_ENV_SECRET", "FIXTURE_LABEL_SECRET", "FIXTURE_IMAGE_LABEL",
		"/srv/shop/secrets", "/run/secrets", "shop_default", "172.18", "config_files", "compose.yaml",
		"daemon off", "redis-server", "Up 3 hours", "PublicPort", "DB_PASSWORD", "com.example.owner",
	} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("report contains %q", forbidden)
		}
	}
}

// The decode structs are the allowlist: adding a field is a reviewed change.
func TestEngineStructsAreTheAllowlist(t *testing.T) {
	fields := func(v any) []string {
		var out []string
		rt := reflect.TypeOf(v)
		for i := 0; i < rt.NumField(); i++ {
			out = append(out, rt.Field(i).Name)
		}
		sort.Strings(out)
		return out
	}
	if got, want := fields(apiContainer{}), []string{"Created", "ID", "Image", "ImageID", "Labels", "Names", "State"}; !reflect.DeepEqual(got, want) {
		t.Errorf("apiContainer fields = %v, want %v", got, want)
	}
	if got, want := fields(apiImage{}), []string{"ID", "Manifests", "RepoDigests", "RepoTags"}; !reflect.DeepEqual(got, want) {
		t.Errorf("apiImage fields = %v, want %v", got, want)
	}
	// Image provenance (#8993): only the pulled-from repositories are decoded,
	// never build refs, signatures, platforms or sizes.
	if got, want := fields(apiManifest{}), []string{"ImageData", "Kind"}; !reflect.DeepEqual(got, want) {
		t.Errorf("apiManifest fields = %v, want %v", got, want)
	}
	if got, want := fields(apiImageData{}), []string{"Identity"}; !reflect.DeepEqual(got, want) {
		t.Errorf("apiImageData fields = %v, want %v", got, want)
	}
	if got, want := fields(apiIdentity{}), []string{"Pull"}; !reflect.DeepEqual(got, want) {
		t.Errorf("apiIdentity fields = %v, want %v", got, want)
	}
	if got, want := fields(apiPullIdentity{}), []string{"Repository"}; !reflect.DeepEqual(got, want) {
		t.Errorf("apiPullIdentity fields = %v, want %v", got, want)
	}
	if got, want := fields(composeLabels{}), []string{"Project", "Service", "WorkingDir"}; !reflect.DeepEqual(got, want) {
		t.Errorf("composeLabels fields = %v, want %v", got, want)
	}
}

func errDial(err error) DialFunc {
	return func(context.Context) (net.Conn, error) { return nil, err }
}

func TestDockerDetectMapsFailuresToDistinctStates(t *testing.T) {
	cases := []struct {
		name       string
		dial       DialFunc
		wantState  string
		wantReason string
	}{
		{"socket missing", errDial(&net.OpError{Op: "dial", Net: "unix", Err: syscall.ENOENT}), DetectionAbsent, ""},
		{"permission denied", errDial(&net.OpError{Op: "dial", Net: "unix", Err: syscall.EACCES}), DetectionPresent, ReasonPermissionDenied},
		{"daemon down", errDial(&net.OpError{Op: "dial", Net: "unix", Err: syscall.ECONNREFUSED}), DetectionPresent, ReasonUnavailable},
		{"timeout", errDial(context.DeadlineExceeded), DetectionUnknown, ReasonTimeout},
		{"surprise", errDial(fmt.Errorf("boom")), DetectionUnknown, ReasonUnreachable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			det := newEngineDriver(RuntimeDocker, tc.dial).Detect(context.Background())
			if det.State != tc.wantState || det.Reason != tc.wantReason {
				t.Fatalf("detection = %+v, want state %s reason %q", det, tc.wantState, tc.wantReason)
			}
		})
	}
}

func TestDockerDetectHTTPStatusMapping(t *testing.T) {
	for code, want := range map[int]Detection{
		http.StatusForbidden:           {State: DetectionPresent, Reason: ReasonPermissionDenied},
		http.StatusUnauthorized:        {State: DetectionPresent, Reason: ReasonPermissionDenied},
		http.StatusInternalServerError: {State: DetectionPresent, Reason: ReasonUnavailable},
	} {
		_, dial := newFakeEngine(t, map[string]func(http.ResponseWriter){"/_ping": status(code)})
		if got := newEngineDriver(RuntimeDocker, dial).Detect(context.Background()); got != want {
			t.Errorf("status %d: detection = %+v, want %+v", code, got, want)
		}
	}
}

func TestDockerCollectReportsDetectionFailuresWithoutRequests(t *testing.T) {
	eng, dial := newFakeEngine(t, dockerRoutes(t))
	d := newEngineDriver(RuntimeDocker, dial)
	res := d.Collect(context.Background(), Detection{State: DetectionPresent, Reason: ReasonPermissionDenied})
	if res.Collection != CollectionPermissionDenied || len(res.Workloads) != 0 {
		t.Fatalf("permission result = %+v", res)
	}
	res = d.Collect(context.Background(), Detection{State: DetectionPresent, Reason: ReasonUnavailable})
	if res.Collection != CollectionUnavailable {
		t.Fatalf("unavailable result = %+v", res)
	}
	if n := len(eng.seen()); n != 0 {
		t.Fatalf("made %d requests despite a failed detection", n)
	}
}

func TestDockerCollectFailureModes(t *testing.T) {
	routes := func(containers func(http.ResponseWriter), images func(http.ResponseWriter)) map[string]func(http.ResponseWriter) {
		return map[string]func(http.ResponseWriter){"/containers/json?all=1": containers, "/images/json": images}
	}
	cases := []struct {
		name       string
		routes     map[string]func(http.ResponseWriter)
		wantColl   string
		wantErr    string
		wantCount  int
		wantFull   bool
		wantDigest bool
	}{
		{"forbidden", routes(status(403), status(403)), CollectionPermissionDenied, ReasonPermissionDenied, 0, false, false},
		{"server error", routes(status(500), status(500)), CollectionError, "http_500", 0, false, false},
		{"garbled", routes(serve([]byte("{")), serve([]byte("[]"))), CollectionError, "decode_failed", 0, false, false},
		{"images failed", routes(serve(fixture(t, "docker_containers.json")), status(500)), CollectionOK, "images_list_failed", 5, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, dial := newFakeEngine(t, tc.routes)
			d := newEngineDriver(RuntimeDocker, dial)
			res := d.Collect(context.Background(), Detection{State: DetectionPresent})
			if res.Collection != tc.wantColl || res.Error != tc.wantErr || len(res.Workloads) != tc.wantCount || res.Complete != tc.wantFull {
				t.Fatalf("result = %+v", res)
			}
			for _, w := range res.Workloads {
				if w.ImageDigest != nil && w.Name != "pinned" {
					t.Fatalf("digest %q invented without an image list", *w.ImageDigest)
				}
			}
		})
	}
}

func TestDockerCollectDaemonGoneMidCollection(t *testing.T) {
	d := newEngineDriver(RuntimeDocker, errDial(&net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}))
	res := d.Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionUnavailable || res.Error != "daemon_unreachable" {
		t.Fatalf("result = %+v", res)
	}
}

func TestEngineGetRefusesOversizedBodies(t *testing.T) {
	_, dial := newFakeEngine(t, map[string]func(http.ResponseWriter){"/version": serve([]byte(strings.Repeat("x", 100)))})
	d := newEngineDriver(RuntimeDocker, dial)
	if _, _, err := d.get(context.Background(), "/version", 10); err != errTooLarge {
		t.Fatalf("err = %v, want errTooLarge", err)
	}
}

func TestDockerCapOrdersRunningFirstAndMarksIncomplete(t *testing.T) {
	var cs []map[string]any
	for i := 0; i < 1200; i++ {
		state := "exited"
		if i%2 == 0 {
			state = "running"
		}
		cs = append(cs, map[string]any{
			"Id": fmt.Sprintf("%064x", i), "Names": []string{fmt.Sprintf("/c%d", i)},
			"Image": "app:1", "ImageID": "sha256:" + hex8("a0a0a0a0"),
			"Created": 1700000000 + i, "State": state, "Labels": map[string]string{},
		})
	}
	// A duplicate id must not produce a duplicate workload (the server answers 400).
	cs = append(cs, cs[0])
	body, _ := json.Marshal(cs)
	_, dial := newFakeEngine(t, map[string]func(http.ResponseWriter){
		"/containers/json?all=1": serve(body), "/images/json": serve([]byte("[]")),
	})
	res := newEngineDriver(RuntimeDocker, dial).Collect(context.Background(), Detection{State: DetectionPresent})
	if len(res.Workloads) != MaxWorkloadsPerRuntime || res.ObservedCount != 1200 || res.Complete || res.Error != "truncated" {
		t.Fatalf("len=%d observed=%d complete=%v err=%q", len(res.Workloads), res.ObservedCount, res.Complete, res.Error)
	}
	for _, w := range res.Workloads[:600] {
		if w.State != StateRunning {
			t.Fatalf("running containers must sort first, got %s", w.State)
		}
	}
	ids := map[string]bool{}
	for _, w := range res.Workloads {
		if ids[w.WorkloadID] {
			t.Fatalf("duplicate workload id %s", w.WorkloadID)
		}
		ids[w.WorkloadID] = true
	}
}

func TestPodmanAndDockerShareASocketWithoutDoubleReporting(t *testing.T) {
	podmanRoutes := map[string]func(http.ResponseWriter){
		"/_ping": serve([]byte("OK")), "/version": serve(fixture(t, "podman_version.json")),
	}
	_, dial := newFakeEngine(t, podmanRoutes)
	if got := newEngineDriver(RuntimePodman, dial).Detect(context.Background()); got.State != DetectionPresent || got.Version != "5.1.2" {
		t.Fatalf("podman detection = %+v", got)
	}
	// /var/run/docker.sock symlinked to Podman: the docker driver steps aside.
	if got := newEngineDriver(RuntimeDocker, dial).Detect(context.Background()); got.State != DetectionAbsent {
		t.Fatalf("docker driver on a Podman socket = %+v, want absent", got)
	}
	_, dockerDial := newFakeEngine(t, dockerRoutes(t))
	if got := newEngineDriver(RuntimePodman, dockerDial).Detect(context.Background()); got.State != DetectionAbsent {
		t.Fatalf("podman driver on a Docker socket = %+v, want absent", got)
	}
}

func TestEngineWithoutEndpointIsAbsent(t *testing.T) {
	if got := newEngineDriver(RuntimePodman, nil).Detect(context.Background()); got.State != DetectionAbsent {
		t.Fatalf("detection = %+v", got)
	}
}
