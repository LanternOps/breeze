package yarac

// Engine spike (#6265 Task 1): everything the W02 code assumes about
// yaraxwasm is asserted here, so an engine upgrade that changes one of these
// facts fails loudly instead of silently changing scan behaviour. Outcomes
// are recorded in the W02 PR body ("Spike outcomes").

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	yx "github.com/niallnsec/yaraxwasm"
)

const markerRule = `rule fixture_marker { strings: $a = "breeze_yara_fixture_marker_7f3a" condition: $a }`

func td(p string) string { return filepath.Join("..", "testdata", p) }

// Spec §13 Q1: public packs import pe/elf/hash/math. If this fails, W03's
// pack filter must drop rules importing the missing module (Open Decision 7).
func TestSpikeModulesAvailable(t *testing.T) {
	src, err := os.ReadFile(td("modules.yar"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := yx.Compile(string(src)); err != nil {
		t.Fatalf("pe/elf/hash/math not all available: %v", err)
	}
}

// The console module must be bannable — C5 depends on it.
func TestSpikeConsoleBannable(t *testing.T) {
	_, err := yx.Compile(`import "console" rule r { condition: console.log("x") }`,
		yx.BanModule("console", "banned module", "console is not allowed in Breeze rules"))
	if err == nil {
		t.Fatal("BanModule(console) did not reject an import")
	}
}

// Upstream defaults includes ON; EnableIncludes(false) must turn them off at
// the engine level (C5).
func TestSpikeIncludesDisableable(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "other.yar"), []byte(`rule other { condition: true }`), 0o600); err != nil {
		t.Fatal(err)
	}
	src := `include "` + filepath.ToSlash(filepath.Join(dir, "other.yar")) + `" rule i { condition: true }`
	// Control: with the upstream default the same include resolves, so the
	// failure below is the option working, not a bad path.
	if _, err := yx.Compile(src); err != nil {
		t.Fatalf("control: default-includes compile failed: %v", err)
	}
	if _, err := yx.Compile(src, yx.EnableIncludes(false)); err == nil {
		t.Fatal("EnableIncludes(false) still resolved an include")
	}
}

// Serialize → deserialize round trip on THIS arch.
func TestSpikeSerializeRoundTrip(t *testing.T) {
	rules, err := yx.Compile(markerRule)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := rules.WriteTo(&buf); err != nil {
		t.Fatal(err)
	}
	size := buf.Len()
	again, err := yx.ReadFrom(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := yx.NewScanner(again)
	defer s.Destroy()
	res, err := s.ScanFile(td("files/fixture-a.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if n := len(res.MatchingRules()); n != 1 {
		t.Fatalf("want 1 match after round trip, got %d", n)
	}
	t.Logf("serialized size=%d goos=%s goarch=%s", size, runtime.GOOS, runtime.GOARCH)
}

// Compiled rules expose their pattern list (countPatterns relies on it for
// the C5 strings cap) and matches expose offset + length (matcher.go relies
// on it for matchedStrings).
func TestSpikePatternsAndMatchOffsets(t *testing.T) {
	rules, err := yx.Compile(`rule p { strings: $a = "breeze_yara_fixture_marker_7f3a" $b = "trailer" $c = "absent_token_x" condition: $a and $b and not $c }`)
	if err != nil {
		t.Fatal(err)
	}
	sl := rules.Slice()
	if len(sl) != 1 || len(sl[0].Patterns()) != 3 {
		t.Fatalf("compiled rule must list its 3 patterns, got %+v", sl)
	}
	s := yx.NewScanner(rules)
	defer s.Destroy()
	res, err := s.ScanFile(td("files/fixture-a.bin"))
	if err != nil {
		t.Fatal(err)
	}
	m := res.MatchingRules()
	if len(m) != 1 {
		t.Fatalf("want 1 match, got %d", len(m))
	}
	var gotA bool
	for _, p := range m[0].Patterns() {
		if p.Identifier() == "$a" {
			ms := p.Matches()
			if len(ms) != 1 || ms[0].Offset() != 7 || ms[0].Length() != 31 {
				t.Fatalf("$a match offset/length wrong: %+v", ms)
			}
			gotA = true
		}
	}
	if !gotA {
		t.Fatal("$a not reported among matched patterns")
	}
}

// One scanner per goroutine must be safe (DECISION W02-b relies on it).
func TestSpikeScannerPerGoroutineRace(t *testing.T) {
	rules, err := yx.Compile(markerRule)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := yx.NewScanner(rules)
			defer s.Destroy()
			for j := 0; j < 20; j++ {
				if _, err := s.ScanFile(td("files/fixture-a.bin")); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()
}

// Memory per scanner instance: recorded in the PR's spike outcomes.
func BenchmarkSpikeNewScanner(b *testing.B) {
	rules, err := yx.Compile(markerRule)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s := yx.NewScanner(rules)
		s.Destroy()
	}
}
