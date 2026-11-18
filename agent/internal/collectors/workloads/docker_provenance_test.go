package workloads

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// #9067: every Docker container carries the evidence the engine gave for its
// image's provenance, so the server can refuse to send names it cannot place
// to a registry. confirmed = a registry digest the engine vouches for; local =
// the engine says it was never pulled; unknown = the engine cannot say.

func provenances(ws []Workload) map[string]string {
	out := map[string]string{}
	for _, w := range ws {
		out[w.Name] = val(w.ImageProvenance)
	}
	return out
}

func checkProvenance(t *testing.T, got map[string]string, want map[string]string) {
	t.Helper()
	for name, p := range want {
		if got[name] != p {
			t.Errorf("%s provenance = %q, want %q", name, got[name], p)
		}
	}
}

// Engine API >= 1.54 on the containerd store: the engine's identity decides.
func TestProvenanceContainerdStoreWithIdentity(t *testing.T) {
	res, _ := collectContainerd(t, "docker_version_29_4.json")
	checkProvenance(t, provenances(res.Workloads), map[string]string{
		"alpine":     ProvenanceConfirmed,
		"lab-local":  ProvenanceLocal,
		"app":        ProvenanceConfirmed,
		"nginx-hub":  ProvenanceConfirmed,
		"nginx-team": ProvenanceLocal,
		"loaded":     ProvenanceLocal,
	})
}

// Docker 29.0-29.2 on the containerd store: a repo digest equal to the image
// id is the store's synthetic "name@<id>", which says nothing about a
// registry. Every such image is unknown; its digest is still reported as
// before, the server simply must not look it up.
func TestProvenanceContainerdStoreWithoutIdentityIsUnknown(t *testing.T) {
	res, _ := collectContainerd(t, "docker_version_29_1.json")
	got := provenances(res.Workloads)
	for _, name := range []string{"alpine", "lab-local", "app", "nginx-hub", "nginx-team", "loaded"} {
		if got[name] != ProvenanceUnknown {
			t.Errorf("%s provenance = %q, want unknown", name, got[name])
		}
	}
	if d := val(byName(res.Workloads)["lab-local"].ImageDigest); d != containerdDigest("22222222") {
		t.Errorf("lab-local digest = %q, want unchanged", d)
	}
}

// An identity engine whose identity list failed falls back to the plain list:
// that list carries no provenance, so containerd-store images are unknown.
func TestProvenanceIdentityFallbackIsUnknown(t *testing.T) {
	routes := containerdRoutes(t, "docker_version_29_4.json")
	routes[identityImagesPath] = status(http.StatusBadRequest)
	_, dial := newFakeEngine(t, routes)
	d := newEngineDriver(RuntimeDocker, dial)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	checkProvenance(t, provenances(res.Workloads), map[string]string{
		"alpine":    ProvenanceUnknown,
		"lab-local": ProvenanceUnknown,
	})
}

// The classic store behaves as today: a repo digest is a manifest digest
// (confirmed), no repo digest means it was never pulled (local).
func TestProvenanceClassicStore(t *testing.T) {
	for _, version := range []string{"docker_version_29_1.json", "docker_version_29_4.json"} {
		t.Run(version, func(t *testing.T) {
			routes := dockerRoutes(t)
			routes["/version"] = serve(fixture(t, version))
			routes[identityImagesPath] = routes["/images/json"]
			_, dial := newFakeEngine(t, routes)
			d := newEngineDriver(RuntimeDocker, dial)
			res := d.Collect(context.Background(), d.Detect(context.Background()))
			checkProvenance(t, provenances(res.Workloads), map[string]string{
				"shop-web-1": ProvenanceConfirmed,
				"cache":      ProvenanceConfirmed,
				"builder":    ProvenanceLocal,
				"pinned":     ProvenanceConfirmed,
				"old-web":    ProvenanceConfirmed,
			})
		})
	}
}

// Without the image list there is no evidence at all: no provenance, so the
// server keeps its existing digest-unknown handling.
func TestProvenanceAbsentWhenImageListFailed(t *testing.T) {
	routes := containerdRoutes(t, "docker_version_29_1.json")
	routes["/images/json"] = status(http.StatusInternalServerError)
	_, dial := newFakeEngine(t, routes)
	d := newEngineDriver(RuntimeDocker, dial)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	if res.Complete || len(res.Workloads) == 0 {
		t.Fatalf("result = %+v", res)
	}
	for _, w := range res.Workloads {
		if w.ImageProvenance != nil {
			t.Errorf("%s provenance = %q, want none", w.Name, *w.ImageProvenance)
		}
	}
}

// Podman's image store is not Docker's: the agent makes no provenance claim.
func TestProvenanceNotReportedForPodman(t *testing.T) {
	routes := containerdRoutes(t, "podman_version.json")
	_, dial := newFakeEngine(t, routes)
	d := newEngineDriver(RuntimePodman, dial)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	if len(res.Workloads) == 0 {
		t.Fatalf("result = %+v", res)
	}
	for _, w := range res.Workloads {
		if w.ImageProvenance != nil {
			t.Errorf("%s provenance = %q, want none", w.Name, *w.ImageProvenance)
		}
	}
}

// The server's ingest schema is strict: a server that predates #9067 rejects
// the whole report if the key is present at all, even as null. So the key is
// omitted unless the server said it accepts it.
func TestCollectorSendsProvenanceOnlyWhenServerAcceptsIt(t *testing.T) {
	w := wl("a")
	w.ImageProvenance = strp(ProvenanceUnknown)

	old := New([]Driver{presentDriver(RuntimeDocker, w)}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	raw, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "imageProvenance") {
		t.Fatalf("report for an old server carries imageProvenance: %s", raw)
	}

	s := enabled()
	s.AcceptsImageProvenance = true
	cur := New([]Driver{presentDriver(RuntimeDocker, w)}, WithClock(fixedNow)).Collect(context.Background(), s)
	raw, err = json.Marshal(cur)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"imageProvenance":"unknown"`) {
		t.Fatalf("report for a current server lacks imageProvenance: %s", raw)
	}

	// A workload without evidence omits the key rather than sending null.
	none := New([]Driver{presentDriver(RuntimeDocker, wl("b"))}, WithClock(fixedNow)).Collect(context.Background(), s)
	raw, _ = json.Marshal(none)
	if strings.Contains(string(raw), "imageProvenance") {
		t.Fatalf("workload without evidence carries the key: %s", raw)
	}
}

// Bound drops a value the server's enum would reject instead of losing the report.
func TestBoundDropsUnknownProvenanceValues(t *testing.T) {
	w := wl("a")
	w.ImageProvenance = strp("pulled")
	w.Bound()
	if w.ImageProvenance != nil {
		t.Fatalf("provenance = %q, want nil", *w.ImageProvenance)
	}
	for _, p := range []string{ProvenanceConfirmed, ProvenanceLocal, ProvenanceUnknown} {
		w.ImageProvenance = strp(p)
		w.Bound()
		if val(w.ImageProvenance) != p {
			t.Fatalf("provenance %q not kept", p)
		}
	}
}

// The mapping table, including shapes the fixtures do not carry.
func TestImageProvenanceTable(t *testing.T) {
	id := containerdDigest("66666666")
	other := containerdDigest("77777777")
	pulled := apiImage{Manifests: []apiManifest{{Kind: "image", ImageData: &apiImageData{Identity: &apiIdentity{
		Pull: []apiPullIdentity{{Repository: "docker.io/library/alpine"}},
	}}}}}
	cases := []struct {
		name           string
		digest         string
		identity, drop bool
		img            apiImage
		want           string
	}{
		{"no digest", "", false, false, apiImage{}, ProvenanceLocal},
		{"digest withheld", "", true, true, apiImage{}, ProvenanceLocal},
		{"withheld, then refilled from a pinned ref", id, true, true, apiImage{}, ProvenanceLocal},
		{"classic manifest digest", other, false, false, apiImage{}, ProvenanceConfirmed},
		{"pinned ref digest on an old engine, not the image id", other, false, false, apiImage{}, ProvenanceConfirmed},
		{"containerd synthetic, old engine", id, false, false, apiImage{}, ProvenanceUnknown},
		{"containerd synthetic, identity engine, no Manifests at all", id, true, false, apiImage{}, ProvenanceLocal},
		{"containerd synthetic, identity says pulled here", id, true, false, pulled, ProvenanceConfirmed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := imageProvenance(tc.digest, id, tc.identity, tc.drop, tc.img, "docker.io/library/alpine"); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
