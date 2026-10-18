package heartbeat

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
)

// #6263 W02 — security_scan with ruleSets, end to end: payload refs → fetch
// from an httptest "server" with the agent token → on-device compile →
// worker-pool scan → result keys. The fixtures are invented benign markers.

const goldenSetID = "00000000-0000-4000-8000-000000000001"

func goldenBundle(t *testing.T) ([]byte, string) {
	t.Helper()
	b, err := os.ReadFile("../yarascan/testdata/bundle-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := os.ReadFile("../yarascan/testdata/bundle-v1.golden.json.sha256")
	if err != nil {
		t.Fatal(err)
	}
	return b, strings.TrimSpace(string(s))
}

// bundleServer serves body to requests carrying the agent token and counts
// requests; any other path or token gets 404/401.
func bundleServer(t *testing.T, path string, body []byte) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer agent-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != path {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.breeze.yara-bundle+json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func newTestHeartbeatWithServer(t *testing.T, srv *httptest.Server) *Heartbeat {
	t.Helper()
	cfg := &config.Config{AuthToken: "agent-token"}
	h := &Heartbeat{config: cfg, securityScanner: &security.SecurityScanner{
		QuarantineDir: filepath.Join(t.TempDir(), "quarantine"),
		RuleCacheDir:  filepath.Join(t.TempDir(), "yara", "cache"),
	}}
	if srv != nil {
		cfg.ServerURL = srv.URL
		h.client = srv.Client()
	} else {
		cfg.ServerURL = "http://127.0.0.1:1" // must never be contacted
		h.client = &http.Client{}
	}
	return h
}

func decodeScanResult(t *testing.T, res tools.CommandResult) map[string]any {
	t.Helper()
	if res.Status != "completed" {
		t.Fatalf("status = %q, want completed (error: %s)", res.Status, res.Error)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return out
}

func refPayload(id string, version int, sum string) []any {
	return []any{map[string]any{"id": id, "version": float64(version), "sha256": sum,
		"url": "/api/v1/agents/a/yara/rule-sets/" + id + "/" + strconv.Itoa(version)}}
}

func TestHandleSecurityScanWithRuleSetsUsesYara(t *testing.T) {
	body, sum := goldenBundle(t)
	srv, hits := bundleServer(t, "/api/v1/agents/a/yara/rule-sets/"+goldenSetID+"/3", body)
	h := newTestHeartbeatWithServer(t, srv)
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "x.bin"), []byte("..breeze_yara_fixture_marker_7f3a.."), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "clean.bin"), []byte("nothing here"), 0o600)

	res := handleSecurityScan(h, Command{ID: "c1", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{dir}, "scanRecordId": "rec-1",
		"ruleSets": refPayload(goldenSetID, 3, sum),
	}})
	out := decodeScanResult(t, res)
	if out["engine"] != "yara" || out["threatsFound"].(float64) != 1 || out["filesScanned"].(float64) != 2 {
		t.Fatalf("want yara engine, 1 threat, 2 files; got %+v", out)
	}
	if errs := out["ruleSetErrors"].([]any); len(errs) != 0 {
		t.Fatalf("unexpected ruleSetErrors: %+v", errs)
	}
	th := out["threats"].([]any)[0].(map[string]any)
	if th["ruleName"] != "fixture_marker" || th["name"] != "fixture_marker" || th["type"] != "pup" || th["severity"] != "high" ||
		th["ruleSetId"] != goldenSetID || th["ruleId"] != "00000000-0000-4000-8000-0000000000a1" || th["sha256"] == "" {
		t.Fatalf("threat missing rule detail: %+v", th)
	}
	ms := th["matchedStrings"].([]any)
	if len(ms) != 1 || ms[0].(map[string]any)["offset"].(float64) != 2 {
		t.Fatalf("matched strings wrong: %+v", ms)
	}
	if hits.Load() != 1 {
		t.Fatalf("want exactly one bundle fetch, got %d", hits.Load())
	}
}

func TestHandleSecurityScanIgnoresMalformedRuleSets(t *testing.T) {
	h := newTestHeartbeatWithServer(t, nil)
	for name, raw := range map[string]any{
		"not an array": "not-an-array",
		"off-host url": []any{map[string]any{"id": "x", "version": float64(1), "sha256": strings.Repeat("a", 64), "url": "https://evil.example/api/v1/agents/a"}},
	} {
		t.Run(name, func(t *testing.T) {
			res := handleSecurityScan(h, Command{ID: "c2", Type: tools.CmdSecurityScan, Payload: map[string]any{
				"scanType": "custom", "paths": []any{t.TempDir()}, "ruleSets": raw,
			}})
			out := decodeScanResult(t, res)
			if out["engine"] != "legacy" {
				t.Fatalf("malformed ruleSets must fall back to legacy, got %+v", out)
			}
			errs := out["ruleSetErrors"].([]any)
			if len(errs) != 1 || errs[0].(map[string]any)["code"] != "invalid_refs" || errs[0].(map[string]any)["id"] != "*" {
				t.Fatalf("want one invalid_refs error, got %+v", errs)
			}
		})
	}
}

func TestHandleSecurityScanNoRuleSetsIsW01Shape(t *testing.T) {
	h := newTestHeartbeatWithServer(t, nil)
	res := handleSecurityScan(h, Command{ID: "c3", Type: tools.CmdSecurityScan, Payload: map[string]any{"scanType": "custom", "paths": []any{t.TempDir()}}})
	out := decodeScanResult(t, res)
	if out["engine"] != "legacy" || len(out["ruleSetErrors"].([]any)) != 0 {
		t.Fatalf("no ruleSets must be legacy with no errors, got %+v", out)
	}
	for _, k := range []string{"scanRecordId", "scanType", "durationMs", "threatsFound", "threats", "status", "filesScanned", "timedOut", "partial"} {
		if _, ok := out[k]; !ok {
			t.Errorf("W01 result key %q missing", k)
		}
	}
}

func TestHandleSecurityScanAllSetsFailFallsBackToLegacy(t *testing.T) {
	body, _ := goldenBundle(t)
	srv, _ := bundleServer(t, "/api/v1/agents/a/yara/rule-sets/"+goldenSetID+"/3", body)
	h := newTestHeartbeatWithServer(t, srv)
	dir := t.TempDir()
	// A legacy filename signature (bare literal also used in threats_test.go).
	_ = os.WriteFile(filepath.Join(dir, "how_to_decrypt.txt"), []byte("benign"), 0o600)
	res := handleSecurityScan(h, Command{ID: "c6", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{dir},
		"ruleSets": refPayload(goldenSetID, 3, strings.Repeat("0", 64)), // wrong pin
	}})
	out := decodeScanResult(t, res)
	errs := out["ruleSetErrors"].([]any)
	if out["engine"] != "legacy" || len(errs) != 1 || errs[0].(map[string]any)["code"] != "sha256_mismatch" {
		t.Fatalf("want legacy fallback + sha256_mismatch, got %+v", out)
	}
	if out["threatsFound"].(float64) != 1 {
		t.Fatalf("legacy fallback must still detect: %+v", out)
	}
}

func TestYaraAutoQuarantineNeedsBothFlags(t *testing.T) {
	// Golden bundle has autoQuarantine=false; policy autoQuarantine=true must NOT quarantine (D7).
	body, sum := goldenBundle(t)
	srv, _ := bundleServer(t, "/api/v1/agents/a/yara/rule-sets/"+goldenSetID+"/3", body)
	h := newTestHeartbeatWithServer(t, srv)
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "x.bin"), []byte("breeze_yara_fixture_marker_7f3a"), 0o600)
	res := handleSecurityScan(h, Command{ID: "c4", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{dir}, "autoQuarantine": true,
		"ruleSets": refPayload(goldenSetID, 3, sum),
	}})
	ths := decodeScanResult(t, res)["threats"].([]any)
	if len(ths) != 1 {
		t.Fatalf("want 1 threat, got %+v", ths)
	}
	th := ths[0].(map[string]any)
	if q, _ := th["quarantinedTo"].(string); q != "" || th["quarantineFailed"] == true {
		t.Fatalf("custom set with autoQuarantine=false was quarantined: %+v", th)
	}
	if _, err := os.Stat(filepath.Join(dir, "x.bin")); err != nil {
		t.Fatal("file was moved")
	}
}

func TestAutoQuarantineOncePerFile(t *testing.T) {
	setID := "00000000-0000-4000-8000-000000000002"
	body := []byte(`{"format":"breeze-yara-bundle","v":1,"ruleSetId":"` + setID + `","version":1,"autoQuarantine":true,"rules":[` +
		`{"id":"r1","name":"m_one","severity":"high","source":"rule m_one { strings: $a = \"breeze_yara_fixture_marker_7f3a\" condition: $a }"},` +
		`{"id":"r2","name":"m_two","severity":"high","source":"rule m_two { strings: $a = \"fixture_marker_7f3a\" condition: $a }"}]}`)
	sum := sha256.Sum256(body)
	srv, _ := bundleServer(t, "/api/v1/agents/a/yara/rule-sets/"+setID+"/1", body)
	h := newTestHeartbeatWithServer(t, srv)
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "x.bin"), []byte("breeze_yara_fixture_marker_7f3a"), 0o600)
	res := handleSecurityScan(h, Command{ID: "c5", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{dir}, "autoQuarantine": true,
		"ruleSets": refPayload(setID, 1, hex.EncodeToString(sum[:])),
	}})
	ths := decodeScanResult(t, res)["threats"].([]any)
	if len(ths) != 2 {
		t.Fatalf("want 2 threats, got %d", len(ths))
	}
	a, b := ths[0].(map[string]any), ths[1].(map[string]any)
	if a["quarantinedTo"] == nil || a["quarantinedTo"] == "" || a["quarantinedTo"] != b["quarantinedTo"] || a["quarantineFailed"] == true || b["quarantineFailed"] == true {
		t.Fatalf("file must be quarantined once and shared: %+v / %+v", a, b)
	}
	bqz, _ := filepath.Glob(filepath.Join(h.securityScanner.QuarantineDir, "*.bqz"))
	if len(bqz) != 1 {
		t.Fatalf("want exactly one .bqz, got %d", len(bqz))
	}
	if _, err := os.Stat(filepath.Join(dir, "x.bin")); !os.IsNotExist(err) {
		t.Fatal("original file must be gone after quarantine")
	}
}

func TestHandleSecurityScanDoesNotMutateSharedScanner(t *testing.T) {
	body, sum := goldenBundle(t)
	srv, _ := bundleServer(t, "/api/v1/agents/a/yara/rule-sets/"+goldenSetID+"/3", body)
	h := newTestHeartbeatWithServer(t, srv)
	_ = handleSecurityScan(h, Command{ID: "c7", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{t.TempDir()}, "ruleSets": refPayload(goldenSetID, 3, sum),
	}})
	if h.securityScanner.Matcher != nil {
		t.Fatal("per-scan matcher leaked onto the shared scanner")
	}
}
