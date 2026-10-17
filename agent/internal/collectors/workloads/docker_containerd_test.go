package workloads

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// Docker's containerd image store reports RepoDigests as "name@<image id>" for
// every named image, built and loaded ones included (#8993), so the RepoDigests
// entry alone no longer separates a registry image from a local build.

const identityImagesPath = "/images/json?manifests=1&identity=1"

func containerdDigest(block string) string { return "sha256:" + strings.Repeat(block, 64/len(block)) }

func containerdRoutes(t *testing.T, versionFixture string) map[string]func(w http.ResponseWriter) {
	images := serve(fixture(t, "docker_containerd_images.json"))
	return map[string]func(w http.ResponseWriter){
		"/_ping":                 serve([]byte("OK")),
		"/version":               serve(fixture(t, versionFixture)),
		"/containers/json?all=1": serve(fixture(t, "docker_containerd_containers.json")),
		"/images/json":           images,
		identityImagesPath:       images,
	}
}

func collectContainerd(t *testing.T, versionFixture string) (Result, []string) {
	t.Helper()
	eng, dial := newFakeEngine(t, containerdRoutes(t, versionFixture))
	d := newEngineDriver(RuntimeDocker, dial)
	det := d.Detect(context.Background())
	if det.State != DetectionPresent || det.apiVersion == "" {
		t.Fatalf("detection = %+v", det)
	}
	res := d.Collect(context.Background(), det)
	if res.Collection != CollectionOK || !res.Complete || len(res.Workloads) != 6 {
		t.Fatalf("result = %+v", res)
	}
	return res, eng.seen()
}

// Engine API >= 1.54 (Docker 29.3+): the image's own provenance decides.
func TestContainerdStoreUsesImageIdentityForProvenance(t *testing.T) {
	res, seen := collectContainerd(t, "docker_version_29_4.json")
	want := []string{"GET /_ping", "GET /version", "GET /containers/json?all=1", "GET " + identityImagesPath}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("requests = %v, want %v", seen, want)
	}
	ws := byName(res.Workloads)
	checks := []struct{ name, got, want string }{
		{"pulled image keeps its digest", val(ws["alpine"].ImageDigest), containerdDigest("11111111")},
		{"local build has no digest", val(ws["lab-local"].ImageDigest), "<nil>"},
		{"local build keeps its name", val(ws["lab-local"].ImageRepository), "docker.io/library/lab-local"},
		{"local build keeps its image id", val(ws["lab-local"].ImageID), containerdDigest("22222222")},
		{"pushed build keeps the pushed digest", val(ws["app"].ImageDigest), containerdDigest("33333333")},
		{"pulled repository keeps its digest", val(ws["nginx-hub"].ImageDigest), containerdDigest("44444444")},
		{"retag to another repository has no digest", val(ws["nginx-team"].ImageDigest), "<nil>"},
		{"loaded image without identity has no digest", val(ws["loaded"].ImageDigest), "<nil>"},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
	// Provenance only gates the digest: build refs and image labels never
	// reach the report.
	b, err := json.Marshal(res.Workloads)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"q4kxyz", "FIXTURE_IMAGE_LABEL", "Identity", "Pull"} {
		if strings.Contains(string(b), secret) {
			t.Errorf("report contains %q", secret)
		}
	}
}

// Engine API < 1.54 (Docker 29.0-29.2) cannot report provenance through the
// list endpoint: the request and the reported digests stay as before.
func TestContainerdStoreOnOlderEngineKeepsRepoDigests(t *testing.T) {
	res, seen := collectContainerd(t, "docker_version_29_1.json")
	want := []string{"GET /_ping", "GET /version", "GET /containers/json?all=1", "GET /images/json"}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("requests = %v, want %v", seen, want)
	}
	if got := val(byName(res.Workloads)["lab-local"].ImageDigest); got != containerdDigest("22222222") {
		t.Fatalf("lab-local digest = %q, want the repo digest unchanged", got)
	}
}

// The classic image store on a new engine: a repo digest is a manifest digest,
// never the image id, so it is kept whether or not the image has an identity.
func TestClassicStoreOnIdentityEngineKeepsRepoDigests(t *testing.T) {
	routes := dockerRoutes(t)
	routes["/version"] = serve(fixture(t, "docker_version_29_4.json"))
	routes[identityImagesPath] = routes["/images/json"]
	eng, dial := newFakeEngine(t, routes)
	d := newEngineDriver(RuntimeDocker, dial)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	ws := byName(res.Workloads)
	if got := val(ws["shop-web-1"].ImageDigest); got != "sha256:"+hex8("d1d1d1d1") {
		t.Errorf("web digest = %q", got)
	}
	if got := val(ws["builder"].ImageDigest); got != "<nil>" {
		t.Errorf("local build digest = %q", got)
	}
	if seen := eng.seen(); seen[len(seen)-1] != "GET "+identityImagesPath {
		t.Errorf("requests = %v", seen)
	}
}

// Podman never gets the Docker-only identity query, whatever API it claims.
func TestPodmanNeverRequestsImageIdentity(t *testing.T) {
	var v map[string]any
	if err := json.Unmarshal(fixture(t, "podman_version.json"), &v); err != nil {
		t.Fatal(err)
	}
	v["ApiVersion"] = "1.99"
	high, _ := json.Marshal(v)
	routes := containerdRoutes(t, "podman_version.json")
	routes["/version"] = serve(high)
	eng, dial := newFakeEngine(t, routes)
	d := newEngineDriver(RuntimePodman, dial)
	det := d.Detect(context.Background())
	if det.apiVersion != "1.99" {
		t.Fatalf("detection = %+v", det)
	}
	d.Collect(context.Background(), det)
	for _, r := range eng.seen() {
		if strings.Contains(r, "identity") {
			t.Fatalf("podman requested %s", r)
		}
	}
}

// An identity engine that refuses or garbles the identity list falls back to
// the plain list once: digests behave as before instead of all being lost.
func TestIdentityListFailureFallsBackToPlainList(t *testing.T) {
	for name, broken := range map[string]func(http.ResponseWriter){
		"http 400": status(http.StatusBadRequest),
		"not json": serve([]byte("{not json")),
		"http 500": status(http.StatusInternalServerError),
	} {
		t.Run(name, func(t *testing.T) {
			routes := containerdRoutes(t, "docker_version_29_4.json")
			routes[identityImagesPath] = broken
			eng, dial := newFakeEngine(t, routes)
			d := newEngineDriver(RuntimeDocker, dial)
			res := d.Collect(context.Background(), d.Detect(context.Background()))
			if res.Collection != CollectionOK || !res.Complete || res.Error != "" {
				t.Fatalf("result = %+v", res)
			}
			ws := byName(res.Workloads)
			if got := val(ws["alpine"].ImageDigest); got != containerdDigest("11111111") {
				t.Errorf("alpine digest = %q", got)
			}
			if got := val(ws["lab-local"].ImageDigest); got != containerdDigest("22222222") {
				t.Errorf("lab-local digest = %q, want the pre-identity behavior", got)
			}
			seen := eng.seen()
			if want := []string{"GET " + identityImagesPath, "GET /images/json"}; !reflect.DeepEqual(seen[len(seen)-2:], want) {
				t.Errorf("requests = %v", seen)
			}
		})
	}
	// Both lists failing is the existing incomplete snapshot, not a retry loop.
	routes := containerdRoutes(t, "docker_version_29_4.json")
	routes[identityImagesPath] = status(http.StatusBadRequest)
	routes["/images/json"] = status(http.StatusInternalServerError)
	eng, dial := newFakeEngine(t, routes)
	d := newEngineDriver(RuntimeDocker, dial)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	if res.Collection != CollectionOK || res.Complete || res.Error != "images_list_failed" {
		t.Fatalf("result = %+v", res)
	}
	if got := len(eng.seen()); got != 5 {
		t.Fatalf("requests = %v, want ping, version, containers and two image lists", eng.seen())
	}
}

// A container created from a bare image id recovers its name from the image's
// tags, and provenance is checked against that recovered repository.
func TestContainerdBareImageIDRefUsesRecoveredRepository(t *testing.T) {
	var list []apiImage
	if err := json.Unmarshal(fixture(t, "docker_containerd_images.json"), &list); err != nil {
		t.Fatal(err)
	}
	images := map[string]apiImage{}
	for _, img := range list {
		images[normalizeImageID(img.ID)] = img
	}
	retag, local := containerdDigest("44444444"), containerdDigest("22222222")
	ws := byName(buildContainerWorkloads([]apiContainer{
		{ID: strings.Repeat("e1", 32), Names: []string{"/by-id-pulled"}, Image: retag, ImageID: retag},
		{ID: strings.Repeat("e2", 32), Names: []string{"/by-id-local"}, Image: local, ImageID: local},
		{ID: strings.Repeat("e3", 32), Names: []string{"/pinned-local"}, Image: "lab-local@" + local, ImageID: local},
	}, images, true))
	checks := []struct{ name, got, want string }{
		{"recovered ref sorts to the hub tag", val(ws["by-id-pulled"].ImageRef), "nginx:1.27"},
		{"recovered pulled repository keeps its digest", val(ws["by-id-pulled"].ImageDigest), retag},
		{"recovered local build has no repo digest", val(ws["by-id-local"].ImageDigest), "<nil>"},
		// A digest-pinned reference keeps the digest it names; the server
		// classifies any pinned reference as pinned before looking at it.
		{"pinned reference keeps its own digest", val(ws["pinned-local"].ImageDigest), local},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
}

func TestAPIVersionAtLeast(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"1.54", true},
		{"1.55", true},
		{"1.100", true},
		{"2.0", true},
		{"1.53", false},
		{"1.9", false},
		{"0.99", false},
		{"", false},
		{"1", false},
		{"1.x", false},
		{"v1.54", false},
		{" 1.54", false},
	}
	for _, tc := range cases {
		if got := apiVersionAtLeast(tc.in, 1, 54); got != tc.want {
			t.Errorf("apiVersionAtLeast(%q, 1, 54) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestPulledFrom(t *testing.T) {
	pulled := func(repos ...string) apiImage {
		var ps []apiPullIdentity
		for _, r := range repos {
			ps = append(ps, apiPullIdentity{Repository: r})
		}
		return apiImage{Manifests: []apiManifest{
			{Kind: "attestation"},
			{Kind: "image", ImageData: &apiImageData{Identity: &apiIdentity{Pull: ps}}},
		}}
	}
	cases := []struct {
		name string
		img  apiImage
		repo string
		want bool
	}{
		{"exact", pulled("docker.io/library/alpine"), "docker.io/library/alpine", true},
		{"hub alias normalized", pulled("index.docker.io/library/alpine"), "docker.io/library/alpine", true},
		{"familiar name normalized", pulled("alpine"), "docker.io/library/alpine", true},
		{"host case normalized", pulled("GHCR.io/o/r"), "ghcr.io/o/r", true},
		{"other repository", pulled("docker.io/library/nginx"), "registry.example.com/team/nginx", false},
		{"one of several", pulled("docker.io/library/nginx", "registry.example.com/team/nginx"), "registry.example.com/team/nginx", true},
		{"no identity", apiImage{Manifests: []apiManifest{{Kind: "image", ImageData: &apiImageData{}}}}, "docker.io/library/alpine", false},
		{"no manifests", apiImage{}, "docker.io/library/alpine", false},
		{"identity on a non-image manifest is ignored", apiImage{Manifests: []apiManifest{
			{Kind: "attestation", ImageData: &apiImageData{Identity: &apiIdentity{Pull: []apiPullIdentity{{Repository: "docker.io/library/alpine"}}}}},
		}}, "docker.io/library/alpine", false},
		{"empty repository", pulled(""), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.img.pulledFrom(tc.repo); got != tc.want {
				t.Fatalf("pulledFrom(%q) = %v, want %v", tc.repo, got, tc.want)
			}
		})
	}
}
