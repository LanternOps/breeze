package discovery

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

const testEpoch = "abababababababababababababababababababababababababababababababab"

func testDispatch(deadline time.Time) AdjacencyDispatch {
	return AdjacencyDispatch{AcceptedAdjacencyVersions: []int{2}, ProducerEpoch: testEpoch, SourceIdentity: "org:site:discovery:dev",
		Deadline: deadline, Protocols: []string{SectionLLDP, SectionCDP, SectionFDB, SectionInterfaces}, Contexts: []string{"default"}, ExpectedIntervalSeconds: 3600}
}

func testTarget(ip string, macs int) TargetPhysical {
	fdb := newSection(SectionFDB, "default")
	for i := 0; i < macs; i++ {
		mac := "02:00:00:00:" + hex2(i/256) + ":" + hex2(i%256)
		id := uint32(1)
		fdb.Fdb = append(fdb.Fdb, FdbRow{RowKey: "default|1|" + mac + "|3", BridgeContext: "default", FDBID: &id, MAC: mac, BridgePort: 3,
			Status: "learned", VLANMapping: "unknown"})
	}
	fdb.RowCount = len(fdb.Fdb)
	return TargetPhysical{Target: ip, CapturedAt: time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC), Sections: []PhysicalSection{
		newSection(SectionLLDP, "default").withOutcome(OutcomeComplete, ""),
		newSection(SectionCDP, "default").withOutcome(OutcomeFailed, "timeout"),
		fdb,
		newSection(SectionInterfaces, "default").withOutcome(OutcomeComplete, ""),
	}}
}

func hex2(n int) string { const h = "0123456789abcdef"; return string([]byte{h[(n>>4)&15], h[n&15]}) }

type recordedPost struct {
	auth string
	path string
	body adjacencyPostBody
	raw  []byte
}

type fakeServer struct {
	mu      sync.Mutex
	posts   []recordedPost
	respond func(body adjacencyPostBody) (int, any)
}

func (f *fakeServer) handler(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body adjacencyPostBody
	_ = json.Unmarshal(raw, &body)
	f.mu.Lock()
	f.posts = append(f.posts, recordedPost{auth: r.Header.Get("Authorization"), path: r.URL.Path, body: body, raw: raw})
	f.mu.Unlock()
	status, resp := 200, any(acceptAll(body))
	if f.respond != nil {
		status, resp = f.respond(body)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(resp)
}

func acceptAll(body adjacencyPostBody) AdjacencyResponse {
	base := body.Report.SnapshotID
	if body.Report.ReportKind == "unchanged" {
		base = body.Report.BaseSnapshotID
	}
	return AdjacencyResponse{Accepted: true, ContentDigest: body.Report.ContentDigest, BaseSnapshotID: base}
}

func newTestTransport(t *testing.T, srv *httptest.Server, now *time.Time) (*AdjacencyTransport, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	return &AdjacencyTransport{
		Dispatch:        testDispatch(now.Add(15 * time.Minute)),
		ParentJobID:     "20000000-0000-4000-8000-000000000001",
		ParentCommandID: "20000000-0000-4000-8000-000000000001",
		Poster:          &HTTPAdjacencyPoster{Client: srv.Client(), URL: srv.URL + "/api/v1/agents/agent-1/topology/adjacency", Authorization: "Bearer tok", Retry: httputil.RetryConfig{MaxRetries: 0}},
		State:           OpenAdjacencyState(path),
		Now:             func() time.Time { return *now },
	}, path
}

func TestParseAdjacencyDispatch(t *testing.T) {
	good := map[string]any{"acceptedAdjacencyVersions": []any{float64(2)}, "producerEpoch": testEpoch, "sourceIdentity": "o:s:discovery:d",
		"deadline": "2026-09-25T12:15:00Z", "protocols": []any{"lldp", "fdb"}, "contexts": []any{"default"}, "expectedIntervalSeconds": float64(3600)}
	d, ok := ParseAdjacencyDispatch(good)
	if !ok || d.ExpectedIntervalSeconds != 3600 || len(d.Protocols) != 2 {
		t.Fatalf("valid dispatch rejected: %+v %v", d, ok)
	}
	for name, mutate := range map[string]func(m map[string]any){
		"no v2":        func(m map[string]any) { m["acceptedAdjacencyVersions"] = []any{float64(1)} },
		"bad epoch":    func(m map[string]any) { m["producerEpoch"] = "xyz" },
		"no identity":  func(m map[string]any) { delete(m, "sourceIdentity") },
		"bad interval": func(m map[string]any) { m["expectedIntervalSeconds"] = float64(10) },
		"bad protocol": func(m map[string]any) { m["protocols"] = []any{"ospf"} },
		"two contexts": func(m map[string]any) { m["contexts"] = []any{"a", "b"} },
		"no deadline":  func(m map[string]any) { delete(m, "deadline") },
	} {
		m := map[string]any{}
		for k, v := range good {
			m[k] = v
		}
		mutate(m)
		if _, ok := ParseAdjacencyDispatch(m); ok {
			t.Fatalf("%s: accepted", name)
		}
	}
	if _, ok := ParseAdjacencyDispatch(nil); ok {
		t.Fatal("nil accepted")
	}
}

func TestAdjacencyTransportFullThenUnchanged(t *testing.T) {
	fs := &fakeServer{}
	srv := httptest.NewServer(http.HandlerFunc(fs.handler))
	defer srv.Close()
	now := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
	tr, path := newTestTransport(t, srv, &now)

	out := tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	if len(out) != 1 || !out[0].Accepted || out[0].ReportKind != "full" {
		t.Fatalf("first send: %+v", out)
	}
	p := fs.posts[0]
	if p.auth != "Bearer tok" || p.path != "/api/v1/agents/agent-1/topology/adjacency" || p.body.ParentJobID != tr.ParentJobID {
		t.Fatalf("request: %+v", p)
	}
	r := p.body.Report
	if r.Version != 2 || r.ParentCommandID != tr.ParentCommandID || r.ProducerEpoch != testEpoch || r.ReportKind != "full" ||
		r.Source.SourceKey != "snmp:192.0.2.10" || r.Source.Zone != nil || r.ExpectedIntervalSeconds != 3600 || r.FinalManifest == nil || len(r.Sections) != 4 {
		t.Fatalf("report envelope: %+v", r)
	}
	if strings.Contains(string(p.raw), "org:site") {
		t.Fatal("source identity must never be uploaded")
	}
	id := AdjacencyDigestIdentity{SourceIdentity: "org:site:discovery:dev", ProducerEpoch: testEpoch, Source: r.Source}
	want, _ := AdjacencyReportDigest(id, r.Sections)
	if r.ContentDigest != want {
		t.Fatalf("report digest %s want %s", r.ContentDigest, want)
	}
	for i, s := range r.Sections {
		d, _ := AdjacencyScopeDigest(id, s)
		m := r.FinalManifest.Scopes[i]
		if s.ContentDigest != d || m.ContentDigest != d || m.Kind != s.Kind || m.RowCount != s.RowCount || m.Outcome != s.Outcome {
			t.Fatalf("section %s digest/manifest mismatch", s.Kind)
		}
	}
	firstSeq := r.Sequence

	now = now.Add(10 * time.Minute)
	tr.Dispatch.Deadline = now.Add(15 * time.Minute)
	out = tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	u := fs.posts[1].body.Report
	if !out[0].Accepted || u.ReportKind != "unchanged" || u.BaseSnapshotID != r.SnapshotID || u.ContentDigest != r.ContentDigest || len(u.Sections) != 0 {
		t.Fatalf("second send not unchanged: %+v", u)
	}
	if u.Sequence <= firstSeq && len(u.Sequence) <= len(firstSeq) {
		t.Fatalf("sequence did not advance: %s -> %s", firstSeq, u.Sequence)
	}
	// Persisted: a fresh store resumes the baseline.
	reopened := OpenAdjacencyState(path)
	if st := reopened.Target("192.0.2.10"); st.AckSnapshotID != r.SnapshotID || st.AckDigest != r.ContentDigest {
		t.Fatalf("state not persisted: %+v", st)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm()&0077 != 0 {
		t.Fatalf("state file perms: %v %v", info, err)
	}
}

func TestAdjacencyTransportChangedDigestSendsFull(t *testing.T) {
	fs := &fakeServer{}
	srv := httptest.NewServer(http.HandlerFunc(fs.handler))
	defer srv.Close()
	now := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
	tr, _ := newTestTransport(t, srv, &now)
	tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 4)})
	if k := fs.posts[1].body.Report.ReportKind; k != "full" {
		t.Fatalf("changed content sent %s", k)
	}
}

func TestAdjacencyTransportRejectionClearsBaseline(t *testing.T) {
	for _, tc := range []struct {
		name    string
		respond func(adjacencyPostBody) (int, any)
	}{
		{"4xx", func(adjacencyPostBody) (int, any) { return 403, map[string]string{"error": "target_not_authorized"} }},
		{"not accepted", func(adjacencyPostBody) (int, any) {
			return 200, AdjacencyResponse{Accepted: false, Reason: "full_snapshot_required"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fs := &fakeServer{}
			srv := httptest.NewServer(http.HandlerFunc(fs.handler))
			defer srv.Close()
			now := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
			tr, _ := newTestTransport(t, srv, &now)
			tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
			fs.respond = tc.respond
			out := tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
			if out[0].Accepted {
				t.Fatal("rejection reported accepted")
			}
			if st := tr.State.Target("192.0.2.10"); st.AckDigest != "" || st.AckSnapshotID != "" || st.Pending != nil {
				t.Fatalf("baseline not cleared: %+v", st)
			}
			fs.respond = nil
			tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
			if k := fs.posts[2].body.Report.ReportKind; k != "full" {
				t.Fatalf("after rejection sent %s", k)
			}
		})
	}
}

func TestAdjacencyTransportServerErrorKeepsBaseline(t *testing.T) {
	fs := &fakeServer{}
	srv := httptest.NewServer(http.HandlerFunc(fs.handler))
	defer srv.Close()
	now := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
	tr, _ := newTestTransport(t, srv, &now)
	tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	ack := tr.State.Target("192.0.2.10").AckDigest
	fs.respond = func(adjacencyPostBody) (int, any) { return 503, map[string]string{"error": "down"} }
	out := tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	if out[0].Accepted || tr.State.Target("192.0.2.10").AckDigest != ack {
		t.Fatalf("5xx changed baseline: %+v", out)
	}
}

func TestAdjacencyTransportDeadlinePassedPostsNothing(t *testing.T) {
	fs := &fakeServer{}
	srv := httptest.NewServer(http.HandlerFunc(fs.handler))
	defer srv.Close()
	now := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
	tr, _ := newTestTransport(t, srv, &now)
	tr.Dispatch.Deadline = now
	out := tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	if len(fs.posts) != 0 || out[0].Reason != "deadline_passed" {
		t.Fatalf("posted after deadline: %d %+v", len(fs.posts), out)
	}
}

func TestAdjacencyTransportDailyRevalidationAndEpochReset(t *testing.T) {
	fs := &fakeServer{}
	srv := httptest.NewServer(http.HandlerFunc(fs.handler))
	defer srv.Close()
	now := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
	tr, _ := newTestTransport(t, srv, &now)
	tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	now = now.Add(25 * time.Hour)
	tr.Dispatch.Deadline = now.Add(time.Minute)
	tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	if k := fs.posts[1].body.Report.ReportKind; k != "full" {
		t.Fatalf("stale baseline sent %s", k)
	}
	tr.Dispatch.ProducerEpoch = strings.Repeat("c", 64)
	tr.Send(context.Background(), []TargetPhysical{testTarget("192.0.2.10", 3)})
	r := fs.posts[2].body.Report
	if r.ReportKind != "full" || r.ProducerEpoch != tr.Dispatch.ProducerEpoch {
		t.Fatalf("epoch change sent %s/%s", r.ReportKind, r.ProducerEpoch)
	}
}

func TestAdjacencyTransportBoundsOversizedReport(t *testing.T) {
	fs := &fakeServer{}
	srv := httptest.NewServer(http.HandlerFunc(fs.handler))
	defer srv.Close()
	now := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
	tr, _ := newTestTransport(t, srv, &now)
	target := testTarget("192.0.2.10", 20000)
	long := strings.Repeat("x", 250)
	for i := range target.Sections[2].Fdb {
		target.Sections[2].Fdb[i].IfName = long
	}
	tr.Send(context.Background(), []TargetPhysical{target})
	if len(fs.posts) != 1 {
		t.Fatalf("posts = %d", len(fs.posts))
	}
	r := fs.posts[0].body.Report
	encoded, _ := json.Marshal(r)
	if len(encoded) > AdjacencyV2MaxBytes {
		t.Fatalf("report %d bytes exceeds limit", len(encoded))
	}
	var fdb PhysicalSection
	for _, s := range r.Sections {
		if s.Kind == SectionFDB {
			fdb = s
		}
	}
	if fdb.Outcome != OutcomePartial || fdb.ReasonCode != "limit_exceeded" || fdb.OmittedRowCount == 0 || fdb.RowCount != len(fdb.Fdb) ||
		fdb.OmittedRowCount+fdb.RowCount != 20000 {
		t.Fatalf("fdb not bounded: outcome=%s reason=%s rows=%d omitted=%d", fdb.Outcome, fdb.ReasonCode, fdb.RowCount, fdb.OmittedRowCount)
	}
	for i := 1; i < len(fdb.Fdb); i++ {
		if fdb.Fdb[i-1].RowKey >= fdb.Fdb[i].RowKey {
			t.Fatal("bounded rows are not a rowKey-sorted prefix")
		}
	}
	id := AdjacencyDigestIdentity{SourceIdentity: "org:site:discovery:dev", ProducerEpoch: testEpoch, Source: r.Source}
	if want, _ := AdjacencyReportDigest(id, r.Sections); want != r.ContentDigest {
		t.Fatal("digest not recomputed after bounding")
	}
	for _, m := range r.FinalManifest.Scopes {
		if m.Kind == SectionFDB && (m.OmittedRowCount != fdb.OmittedRowCount || m.RowCount != fdb.RowCount || m.Outcome != OutcomePartial) {
			t.Fatalf("manifest not updated: %+v", m)
		}
	}
}

func TestAdjacencyTransportFillsMissingRequestedScopes(t *testing.T) {
	fs := &fakeServer{}
	srv := httptest.NewServer(http.HandlerFunc(fs.handler))
	defer srv.Close()
	now := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
	tr, _ := newTestTransport(t, srv, &now)
	tr.Dispatch.Protocols = []string{SectionLLDP, SectionFDB}
	target := testTarget("192.0.2.10", 1)
	target.Sections = target.Sections[2:3] // only fdb collected; cdp/interfaces not requested
	tr.Send(context.Background(), []TargetPhysical{target})
	r := fs.posts[0].body.Report
	if len(r.Sections) != 2 || r.Sections[0].Kind != SectionLLDP || r.Sections[0].Outcome != OutcomeNotAttempted || r.Sections[1].Kind != SectionFDB {
		t.Fatalf("scopes: %+v", r.Sections)
	}
}

func TestAdjacencyStateMalformedAndBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	s := OpenAdjacencyState(path)
	if st := s.Target("192.0.2.1"); st.AckDigest != "" {
		t.Fatal("malformed state produced a baseline")
	}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < maxAdjacencyTargets+5; i++ {
		ip := "10.0." + itoa(i/256) + "." + itoa(i%256)
		s.update(ip, func(st *TargetAdjacencyState) { st.ProducerEpoch = testEpoch }, base.Add(time.Duration(i)*time.Second))
	}
	if n := s.Len(); n != maxAdjacencyTargets {
		t.Fatalf("state holds %d targets", n)
	}
	if st := s.Target("10.0.0.0"); st.ProducerEpoch != "" {
		t.Fatal("oldest target not evicted")
	}
}
