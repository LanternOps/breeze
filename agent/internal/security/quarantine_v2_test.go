package security

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/obfuscate"
)

// #6263 W02 — quarantine manifest v2 records the matching YARA rule and the
// reader keeps accepting W01's v1 manifests.

func TestQuarantineManifestV2CarriesRule(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.bin")
	_ = os.WriteFile(src, []byte("payload"), 0o600)
	dest, err := QuarantineThreat(Threat{Name: "r", Path: src, RuleName: "r", RuleSetID: "s1"}, filepath.Join(dir, "q"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(quarantineManifestPath(dest))
	if err != nil {
		t.Fatal(err)
	}
	var m QuarantineManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m.V != 2 || m.RuleName != "r" || m.RuleSetID != "s1" {
		t.Fatalf("manifest v2 fields missing: %+v", m)
	}
	// A legacy hit writes v2 without the rule keys.
	src2 := filepath.Join(dir, "b.bin")
	_ = os.WriteFile(src2, []byte("payload"), 0o600)
	dest2, err := QuarantineThreat(Threat{Name: "Legacy", Path: src2}, filepath.Join(dir, "q"))
	if err != nil {
		t.Fatal(err)
	}
	raw2, _ := os.ReadFile(quarantineManifestPath(dest2))
	if strings.Contains(string(raw2), "ruleName") || strings.Contains(string(raw2), "ruleSetId") {
		t.Fatalf("legacy manifest must omit rule keys: %s", raw2)
	}
}

func writeHandManifest(t *testing.T, dir, manifest string) (payload, target string) {
	t.Helper()
	payload = filepath.Join(dir, "a-1.bqz")
	target = filepath.Join(dir, "a.bin")
	if err := os.WriteFile(payload, obfuscate.DecodeBytes([]byte("hello")), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest = strings.ReplaceAll(manifest, "{{TARGET}}", filepath.ToSlash(target))
	if err := os.WriteFile(quarantineManifestPath(payload), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	return payload, target
}

const helloSHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

func TestRestoreReadsManifestV1(t *testing.T) {
	dir := t.TempDir()
	payload, target := writeHandManifest(t, dir, `{"v":1,"originalPath":"{{TARGET}}","sha256":"`+helloSHA+`","name":"n","type":"malware","severity":"high","quarantinedAt":"2026-10-13T00:00:00Z"}`)
	got, err := RestoreQuarantined(payload, target)
	if err != nil {
		t.Fatalf("v1 manifest must still restore: %v", err)
	}
	if b, _ := os.ReadFile(got); string(b) != "hello" {
		t.Fatalf("restored content wrong: %q", b)
	}
}

func TestRestoreRejectsUnknownManifestVersion(t *testing.T) {
	dir := t.TempDir()
	payload, target := writeHandManifest(t, dir, `{"v":99,"originalPath":"{{TARGET}}","sha256":"`+helloSHA+`","name":"n","type":"malware","severity":"high","quarantinedAt":"2026-10-13T00:00:00Z"}`)
	if _, err := RestoreQuarantined(payload, target); err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("unknown manifest version must be refused, got %v", err)
	}
	if _, err := os.Stat(payload); err != nil {
		t.Fatal("refused restore must leave the payload in place")
	}
}
