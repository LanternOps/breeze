package websocket

// Guard for the GO-2026-6278 govulncheck allowlist entry (#12642).
//
// gorilla/websocket v1.5.3 draws the client frame mask key from the top-level
// math/rand functions (conn.go newMaskKey: rand.Uint32()). The advisory's
// weakness is that this stream is predictable. Since Go 1.22 the top-level
// math/rand functions read runtime.rand, a per-thread ChaCha8 state seeded
// from OS entropy. Two settings bring back a deterministic source:
//   - GODEBUG randautoseed=0 makes the top-level functions start from the
//     Seed(1) source;
//   - GODEBUG randseednop=0 makes rand.Seed replace the runtime source with a
//     seeded one. Since Go 1.24, rand.Seed is otherwise a no-op. randseednop=0
//     is also the default for a module whose `go` line, or `godebug default`,
//     is below go1.24.
//
// What these tests guard (they fail the agent's Go test jobs in CI):
//   - go.mod and any go.work: no randautoseed=0 / randseednop=0 in `godebug`
//     lines, no `godebug default=go1.N` below 1.24, and a `go` line of at least
//     1.24;
//   - every //go:debug directive in the agent module: the same settings;
//   - non-test agent code: no reference to math/rand.Seed under any import
//     name, and no mention of randautoseed or randseednop at all (that catches
//     code that edits GODEBUG at run time with os.Setenv);
//   - the built test binary: the top-level math/rand stream is not the
//     rand.New(rand.NewSource(1)) stream, before or after a rand.Seed(1).
//
// What they do not guard: a GODEBUG variable set in the environment of the
// running agent service. Setting that needs control of the host the agent
// runs on. They also do not cover a change to gorilla/websocket itself; the
// allowlist entry must be reviewed again when that dependency moves.
//
// This is a guard on a build property, not a change at the call site.

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var (
	// A godebug setting that brings back the deterministic source.
	weakRandSetting = regexp.MustCompile(`\b(randautoseed|randseednop)\s*=\s*0\b`)
	// `default=go1.N`: every default from that release applies, and
	// randseednop=0 is the default before Go 1.24.
	godebugDefault = regexp.MustCompile(`\bdefault\s*=\s*go1\.(\d+)`)
	goDirective    = regexp.MustCompile(`(?m)^go\s+1\.(\d+)`)
	goDebugLine    = regexp.MustCompile(`(?m)^//go:debug\s+(.*)$`)
	// Any mention of the two settings in non-test code.
	randGodebugName = regexp.MustCompile(`\b(randautoseed|randseednop)\b`)
)

// minSeedNopMinor is the first Go 1.x release where rand.Seed is a no-op by
// default.
const minSeedNopMinor = 24

const advisoryRef = "(GO-2026-6278, #12642)"

func agentModuleRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("agent module root not found at %s: %v", root, err)
	}
	return root
}

// weakGodebugSettings returns each setting in s (go.mod/go.work text or a
// //go:debug value) that brings back a predictable top-level math/rand.
func weakGodebugSettings(s string) []string {
	var bad []string
	bad = append(bad, weakRandSetting.FindAllString(s, -1)...)
	for _, m := range godebugDefault.FindAllStringSubmatch(s, -1) {
		if minor, _ := strconv.Atoi(m[1]); minor < minSeedNopMinor {
			bad = append(bad, m[0])
		}
	}
	return bad
}

// weakModFile returns the problems in go.mod or go.work text: weak godebug
// settings and a `go` line below 1.24. requireGoLine reports a missing `go`
// line as a problem too.
func weakModFile(text string, requireGoLine bool) []string {
	text = stripGoModComments(text)
	bad := weakGodebugSettings(text)
	m := goDirective.FindStringSubmatch(text)
	switch {
	case m == nil && requireGoLine:
		bad = append(bad, "no `go 1.N` line")
	case m != nil:
		if minor, _ := strconv.Atoi(m[1]); minor < minSeedNopMinor {
			bad = append(bad, fmt.Sprintf("go 1.%s (below 1.%d the default is randseednop=0)", m[1], minSeedNopMinor))
		}
	}
	return bad
}

func stripGoModComments(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i], _, _ = strings.Cut(l, "//")
	}
	return strings.Join(lines, "\n")
}

func TestMaskKeyRNG_ModuleFilesKeepRuntimeSource(t *testing.T) {
	root := agentModuleRoot(t)

	raw, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range weakModFile(string(raw), true) {
		t.Errorf("agent/go.mod: %s; the top-level math/rand stream gorilla/websocket uses for mask keys can become deterministic %s", bad, advisoryRef)
	}

	// A go.work in the module or the repo root would add its own `go` and
	// godebug lines in workspace mode.
	for _, p := range []string{filepath.Join(root, "go.work"), filepath.Join(root, "..", "go.work")} {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, bad := range weakModFile(string(raw), false) {
			t.Errorf("%s: %s; the top-level math/rand stream gorilla/websocket uses for mask keys can become deterministic %s", p, bad, advisoryRef)
		}
	}
}

func TestMaskKeyRNG_SourceKeepsRuntimeSource(t *testing.T) {
	root := agentModuleRoot(t)
	fset := token.NewFileSet()
	scanned := 0

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "vendor", "testdata", "node_modules", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		scanned++
		src := string(raw)

		// //go:debug directives, in test files too: they set the defaults
		// for the binary their package builds.
		for _, m := range goDebugLine.FindAllStringSubmatch(src, -1) {
			for _, bad := range weakGodebugSettings(m[1]) {
				t.Errorf("%s: //go:debug sets %q; the top-level math/rand stream gorilla/websocket uses for mask keys can become deterministic %s", rel, bad, advisoryRef)
			}
		}

		if strings.HasSuffix(path, "_test.go") {
			return nil
		}
		for _, m := range randGodebugName.FindAllString(src, -1) {
			t.Errorf("%s mentions %q; non-test agent code must not touch the math/rand GODEBUG settings %s", rel, m, advisoryRef)
		}
		// Parse only files that can import math/rand. The plain substring
		// covers both "math/rand" and `math/rand` import spellings.
		if !strings.Contains(src, "math/rand") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, raw, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		for _, ref := range mathRandSeedRefs(f) {
			pos := fset.Position(ref.Pos())
			t.Errorf("%s:%d:%d: references math/rand.Seed; non-test agent code must not seed the top-level math/rand stream gorilla/websocket uses for mask keys %s", rel, pos.Line, pos.Column, advisoryRef)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 100 {
		t.Fatalf("scanned only %d Go files under %s; the guard is not looking at the agent tree", scanned, root)
	}
}

// mathRandSeedRefs returns every reference to the package-level
// math/rand.Seed in f, called or not (`g := rand.Seed` counts), under any
// import name, including a dot import.
func mathRandSeedRefs(f *ast.File) []ast.Node {
	names := map[string]bool{}
	dot := false
	for _, imp := range f.Imports {
		if p, _ := strconv.Unquote(imp.Path.Value); p != "math/rand" {
			continue
		}
		switch {
		case imp.Name == nil:
			names["rand"] = true
		case imp.Name.Name == ".":
			dot = true
		case imp.Name.Name != "_":
			names[imp.Name.Name] = true
		}
	}
	if len(names) == 0 && !dot {
		return nil
	}
	var refs []ast.Node
	ast.Inspect(f, func(n ast.Node) bool {
		switch e := n.(type) {
		case *ast.SelectorExpr:
			x, ok := e.X.(*ast.Ident)
			if !ok {
				return true
			}
			if names[x.Name] && e.Sel.Name == "Seed" {
				refs = append(refs, e)
			}
			// Nothing left to visit, and e.Sel must not count as a bare
			// (dot-imported) Seed: `other.Seed` is not math/rand's.
			return false
		case *ast.Ident:
			if dot && e.Name == "Seed" {
				refs = append(refs, e)
			}
		}
		return true
	})
	return refs
}

func TestMaskKeyRNG_ScannersFlagKnownBadInputs(t *testing.T) {
	// Positive and negative controls for the scanners above, so a broken
	// regex or matcher cannot make the tree scans pass vacuously.
	settings := []struct {
		in   string
		want int
	}{
		{"godebug randautoseed=0", 1},
		{"godebug (\n\trandseednop = 0\n)", 1},
		{"default=go1.24,randseednop=0", 1},
		{"godebug default=go1.23", 1},
		{"godebug default=go1.9", 1},
		{"godebug default=go1.24", 0},
		{"godebug randautoseed=1", 0},
		{"godebug randseednop=00", 0},
	}
	for _, c := range settings {
		if got := weakGodebugSettings(c.in); len(got) != c.want {
			t.Errorf("weakGodebugSettings(%q) = %q, want %d hit(s)", c.in, got, c.want)
		}
	}

	mods := []struct {
		in   string
		want int
	}{
		{"module m\n\ngo 1.26.11\n", 0},
		{"module m\n\ngo 1.23\n", 1},
		{"module m\n\ngo 1.26\n\ngodebug randautoseed=0 // test\n", 1},
		{"module m\n\ngo 1.26\n\n// godebug randautoseed=0\n", 0},
		{"module m\n", 1},
	}
	for _, c := range mods {
		if got := weakModFile(c.in, true); len(got) != c.want {
			t.Errorf("weakModFile(%q) = %q, want %d problem(s)", c.in, got, c.want)
		}
	}

	srcs := []struct {
		name string
		src  string
		want int
	}{
		{"plain call", "package p\nimport \"math/rand\"\nfunc f() { rand.Seed(1) }\n", 1},
		{"alias", "package p\nimport mr \"math/rand\"\nfunc f() { mr.Seed(1) }\n", 1},
		{"backtick import", "package p\nimport mr `math/rand`\nfunc f() { mr.Seed(1) }\n", 1},
		{"dot import", "package p\nimport . \"math/rand\"\nfunc f() { Seed(1) }\n", 1},
		{"value reference", "package p\nimport \"math/rand\"\nfunc f() { g := rand.Seed; g(1) }\n", 1},
		{"local Rand.Seed", "package p\nimport \"math/rand\"\nfunc f() { r := rand.New(rand.NewSource(1)); r.Seed(2) }\n", 0},
		{"math/rand/v2", "package p\nimport \"math/rand/v2\"\nfunc f() { _ = rand.Uint32() }\n", 0},
	}
	fset := token.NewFileSet()
	for _, c := range srcs {
		f, err := parser.ParseFile(fset, c.name+".go", c.src, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := len(mathRandSeedRefs(f)); got != c.want {
			t.Errorf("mathRandSeedRefs(%s) = %d, want %d", c.name, got, c.want)
		}
	}

	if !randGodebugName.MatchString(`os.Setenv("GODEBUG", "randautoseed=0")`) {
		t.Error("randGodebugName does not match an os.Setenv of randautoseed")
	}
}

// seedOneWindow is how far into the Seed(1) stream a match is searched for,
// so earlier draws by other code in this binary cannot hide a deterministic
// source.
const seedOneWindow = 1 << 16

// sampleLen is long enough that a chance match against the Seed(1) stream
// (32*sampleLen bits) cannot happen.
const sampleLen = 8

func assertNotSeedOneStream(t *testing.T, label string) {
	t.Helper()
	sample := make([]uint32, sampleLen)
	for i := range sample {
		sample[i] = rand.Uint32()
	}
	ref := rand.New(rand.NewSource(1))
	stream := make([]uint32, seedOneWindow+sampleLen)
	for i := range stream {
		stream[i] = ref.Uint32()
	}
	for off := 0; off <= seedOneWindow; off++ {
		match := true
		for i, v := range sample {
			if stream[off+i] != v {
				match = false
				break
			}
		}
		if match {
			t.Fatalf("%s: top-level math/rand.Uint32 returned the rand.NewSource(1) stream at offset %d; gorilla/websocket mask keys are predictable %s. Check GODEBUG randautoseed/randseednop.", label, off, advisoryRef)
		}
	}
}

func TestMaskKeyRNG_TopLevelStreamIsNotSeedOne(t *testing.T) {
	assertNotSeedOneStream(t, "unseeded")
}

func TestMaskKeyRNG_SeedDoesNotReseedTopLevelStream(t *testing.T) {
	// A rand.Seed call anywhere in the process (a dependency, say) must
	// not make the stream deterministic. That holds while randseednop
	// keeps its Go 1.24+ default. Seed(1) is used because it is the stream
	// the check compares against; the static checks cover other seeds.
	rand.Seed(1) //nolint:staticcheck // deliberately calls the deprecated Seed to prove it is a no-op
	assertNotSeedOneStream(t, "after rand.Seed(1)")
}
