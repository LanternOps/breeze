package workloads

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// forbiddenTokens are verbs and paths that would change state on a host. The
// package is read-only by construction (transport.go); this test is the
// second, independent line: it fails when someone adds a mutating call to any
// non-test source file of the package, whichever driver it is for.
var forbiddenTokens = []string{
	// HTTP verbs on the engine socket
	"http.MethodPost", "http.MethodPut", "http.MethodPatch", "http.MethodDelete",
	`"POST"`, `"PUT"`, `"PATCH"`, `"DELETE"`,
	// Docker / Podman mutating endpoints
	"/containers/create", "/start", "/stop", "/kill", "/restart", "/pause", "/unpause",
	"/remove", "/exec", "/prune", "/images/create", "/build", "/commit", "/rename",
	// Hyper-V
	"Start-VM", "Stop-VM", "Restart-VM", "Suspend-VM", "Resume-VM", "Remove-VM",
	"New-VM", "Set-VM", "Checkpoint-VM", "Restore-VMSnapshot", "Export-VM", "Import-VM",
	// Proxmox
	"pvesh create", "pvesh set", "pvesh delete", "pvesh put", "pvesh post",
	`"qm "`, `"pct "`, "`qm `", "`pct `",
	// engine CLIs (collection talks to the API, never the CLI)
	"docker run", "docker rm", "docker stop", "docker kill", "docker pull",
	"podman run", "podman rm", "podman stop", "podman pull",
}

// execAllowedFiles lists the source files allowed to import os/exec. This wave
// has none; a later driver adds its runner file here in the same change that
// adds the import, which makes the review of that change explicit.
var execAllowedFiles = map[string]bool{}

func packageSources(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		b, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatal(err)
		}
		out[name] = string(b)
	}
	if len(out) == 0 {
		t.Fatal("no source files found; the guard would pass vacuously")
	}
	return out
}

// forbiddenTokensIn returns the forbidden tokens src contains. The os/exec
// import path is removed first: it is not a mutation, and whether a file may
// import it is decided by execAllowedFiles below.
func forbiddenTokensIn(src string) []string {
	src = strings.ReplaceAll(src, `"os/exec"`, "")
	var hits []string
	for _, tok := range forbiddenTokens {
		if strings.Contains(src, tok) {
			hits = append(hits, tok)
		}
	}
	return hits
}

func TestPackageSourceHasNoMutatingVerbsOrPaths(t *testing.T) {
	for name, src := range packageSources(t) {
		for _, tok := range forbiddenTokensIn(src) {
			t.Errorf("%s contains forbidden mutating token %q", name, tok)
		}
	}
}

func TestPackageSourceOnlyBuildsGetRequests(t *testing.T) {
	newRequest := regexp.MustCompile(`http\.NewRequest(WithContext)?\(([^)]*)\)`)
	seen := 0
	for name, src := range packageSources(t) {
		for _, m := range newRequest.FindAllStringSubmatch(src, -1) {
			seen++
			if !strings.Contains(m[2], "http.MethodGet") {
				t.Errorf("%s builds a request that is not GET: %s", name, m[0])
			}
		}
	}
	if seen == 0 {
		t.Fatal("found no NewRequest call; the pattern needs updating or the guard is vacuous")
	}
}

func TestOnlyAllowlistedFilesImportOSExec(t *testing.T) {
	for name, src := range packageSources(t) {
		if strings.Contains(src, `"os/exec"`) && !execAllowedFiles[name] {
			t.Errorf("%s imports os/exec; add it to execAllowedFiles only with a read-only command allowlist", name)
		}
	}
}

// The guard must be able to fail: prove the token scan catches a planted verb.
func TestGuardDetectsAPlantedMutation(t *testing.T) {
	planted := `req, _ := http.NewRequest(http.MethodPost, "http://engine/containers/abc/start", nil)`
	hits := 0
	for _, tok := range forbiddenTokens {
		if strings.Contains(planted, tok) {
			hits++
		}
	}
	if hits < 2 {
		t.Fatalf("planted mutation matched %d forbidden tokens, want at least 2", hits)
	}
}

// The "/exec" path token must catch the engine's exec endpoint but not the
// os/exec import, which TestOnlyAllowlistedFilesImportOSExec governs on its
// own; otherwise a runner file added to execAllowedFiles could never pass.
func TestForbiddenTokenScanIgnoresTheOSExecImport(t *testing.T) {
	if hits := forbiddenTokensIn("import (\n\t\"os/exec\"\n)\n"); len(hits) != 0 {
		t.Fatalf("os/exec import matched %v", hits)
	}
	if hits := forbiddenTokensIn(`"/containers/abc/exec"`); len(hits) == 0 {
		t.Fatal("the engine exec endpoint was not caught")
	}
}
