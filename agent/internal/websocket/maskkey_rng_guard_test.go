package websocket

// Guard for the GO-2026-6278 govulncheck allowlist entry (#12642).
//
// gorilla/websocket v1.5.3 draws the client frame mask key from the top-level
// math/rand functions (conn.go newMaskKey: rand.Uint32()). The advisory's
// weakness is that this stream is predictable. In the Go versions this module
// builds with (go.mod `go` line, 1.22 and later), the top-level math/rand
// functions read runtime.rand: a per-thread ChaCha8 state seeded from OS
// entropy. They fall back to the deterministic Seed(1) source only when
// GODEBUG randautoseed=0 is set, and since Go 1.24 rand.Seed does nothing
// unless randseednop=0 is set (which is also the default for a module whose
// `go` line is 1.23 or lower).
//
// What these tests guard:
//   - the agent module never opts back into the old source: no
//     randautoseed=0 / randseednop=0 in go.mod `godebug` lines or in any
//     //go:debug directive, no `godebug default=go1.N` below 1.24, and a
//     go.mod `go` line of at least 1.24;
//   - agent code outside tests never calls math/rand.Seed;
//   - in the built test binary, the top-level math/rand stream is not the
//     rand.New(rand.NewSource(1)) stream, before or after a rand.Seed(1).
//
// What they do not guard: a GODEBUG variable set in the environment of the
// running agent service. Setting that needs control of the host the agent
// runs on. They also do not cover a change to gorilla/websocket itself; the
// allowlist entry must be reviewed again when that dependency moves.
//
// This is a guard on a build property, not a change at the call site.

import (
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
)

// minSeedNopMinor is the first Go 1.x release where rand.Seed is a no-op by
// default.
const minSeedNopMinor = 24

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

// checkGodebugText reports any setting in s (go.mod/go.work text or a
// //go:debug value) that brings back a predictable top-level math/rand.
func checkGodebugText(t *testing.T, where, s string) {
	t.Helper()
	for _, m := range weakRandSetting.FindAllString(s, -1) {
		t.Errorf("%s sets %q; the top-level math/rand stream gorilla/websocket uses for mask keys becomes deterministic (GO-2026-6278, #12642)", where, m)
	}
	for _, m := range godebugDefault.FindAllStringSubmatch(s, -1) {
		if minor, _ := strconv.Atoi(m[1]); minor < minSeedNopMinor {
			t.Errorf("%s sets %q; before go1.%d rand.Seed reseeds the top-level math/rand stream (GO-2026-6278, #12642)", where, m[0], minSeedNopMinor)
		}
	}
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
	gomod := stripGoModComments(string(raw))
	checkGodebugText(t, "agent/go.mod", gomod)

	m := goDirective.FindStringSubmatch(gomod)
	if m == nil {
		t.Fatal("agent/go.mod has no `go 1.N` line; cannot tell which math/rand defaults apply")
	}
	if minor, _ := strconv.Atoi(m[1]); minor < minSeedNopMinor {
		t.Errorf("agent/go.mod declares go 1.%s; below 1.%d the default is randseednop=0 and rand.Seed reseeds the stream gorilla/websocket uses for mask keys (GO-2026-6278, #12642)", m[1], minSeedNopMinor)
	}

	// A go.work in the module or the repo root would add its own godebug lines.
	for _, p := range []string{filepath.Join(root, "go.work"), filepath.Join(root, "..", "go.work")} {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		checkGodebugText(t, p, stripGoModComments(string(raw)))
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

		// //go:debug directives, in test files too: they set the defaults
		// for the binary their package builds.
		for _, m := range goDebugLine.FindAllStringSubmatch(string(raw), -1) {
			checkGodebugText(t, rel+" //go:debug", m[1])
		}

		if strings.HasSuffix(path, "_test.go") || !strings.Contains(string(raw), `"math/rand"`) {
			return nil
		}
		f, err := parser.ParseFile(fset, path, raw, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		for _, call := range mathRandSeedCalls(f) {
			pos := fset.Position(call.Pos())
			t.Errorf("%s:%d:%d: math/rand.Seed call; non-test agent code must not seed the top-level math/rand stream gorilla/websocket uses for mask keys (GO-2026-6278, #12642)", rel, pos.Line, pos.Column)
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

// mathRandSeedCalls returns calls to the package-level math/rand.Seed in f,
// under any import name (including a dot import).
func mathRandSeedCalls(f *ast.File) []*ast.CallExpr {
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
	var calls []*ast.CallExpr
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch fn := call.Fun.(type) {
		case *ast.SelectorExpr:
			if x, ok := fn.X.(*ast.Ident); ok && names[x.Name] && fn.Sel.Name == "Seed" {
				calls = append(calls, call)
			}
		case *ast.Ident:
			if dot && fn.Name == "Seed" {
				calls = append(calls, call)
			}
		}
		return true
	})
	return calls
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
			t.Fatalf("%s: top-level math/rand.Uint32 returned the rand.NewSource(1) stream at offset %d; gorilla/websocket mask keys are predictable (GO-2026-6278, #12642). Check GODEBUG randautoseed/randseednop.", label, off)
		}
	}
}

func TestMaskKeyRNG_TopLevelStreamIsNotSeedOne(t *testing.T) {
	assertNotSeedOneStream(t, "unseeded")
}

func TestMaskKeyRNG_SeedDoesNotReseedTopLevelStream(t *testing.T) {
	// A rand.Seed call anywhere in the process (a dependency, say) must
	// not make the stream deterministic. That holds while randseednop
	// keeps its Go 1.24+ default.
	rand.Seed(1) //nolint:staticcheck // deliberately calls the deprecated Seed to prove it is a no-op
	assertNotSeedOneStream(t, "after rand.Seed(1)")
}
