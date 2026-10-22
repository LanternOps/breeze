//go:build linux && (amd64 || arm64)

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// The sandbox is proven against a REAL breeze-yarac binary built with
// CGO_ENABLED=0 — the API image's build. It cannot run in this process: the
// sandbox is irreversible, and stage 1 re-executes os.Executable() (here the
// test binary) as stage 2.
//
//	docker run --rm -v "$PWD":/src -w /src/agent golang:1.26.10-alpine \
//	  go test -run Sandbox -v ./cmd/breeze-yarac/
func buildCgoFreeYarac(t *testing.T) string {
	t.Helper()
	abi, err := landlockABI()
	if err != nil || abi < 1 {
		t.Skipf("kernel has no usable Landlock (abi=%d err=%v): the sandbox cannot be proven on this host", abi, err)
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		goBin = filepath.Join(runtime.GOROOT(), "bin", "go")
	}
	out := filepath.Join(t.TempDir(), "breeze-yarac")
	cmd := exec.Command(goBin, "build", "-o", out, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build breeze-yarac: %v\n%s", err, b)
	}
	return out
}

type probeOut struct {
	OK          bool `json:"ok"`
	Sandboxed   bool `json:"sandboxed"`
	LandlockABI int  `json:"landlockAbi"`
	OOMScoreAdj int  `json:"oomScoreAdj"`
	Probes      []struct {
		Name   string `json:"name"`
		Denied bool   `json:"denied"`
		Errno  string `json:"errno"`
	} `json:"probes"`
}

func runProbe(t *testing.T, bin string, args ...string) (int, probeOut, string) {
	t.Helper()
	cmd := exec.Command(bin, append([]string{"sandbox-check"}, args...)...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	var p probeOut
	if jerr := json.Unmarshal(stdout.Bytes(), &p); jerr != nil {
		t.Fatalf("sandbox-check output is not JSON (exit %d): %q stderr=%q", code, stdout.String(), stderr.String())
	}
	return code, p, stderr.String()
}

func TestSandboxDeniesFilesNetworkPtraceSignalsAndExec(t *testing.T) {
	bin := buildCgoFreeYarac(t)
	code, p, stderr := runProbe(t, bin)
	if code != exitOK || !p.OK || !p.Sandboxed {
		t.Fatalf("sandbox-check must apply the sandbox and deny every probe: exit=%d out=%+v stderr=%s", code, p, stderr)
	}
	if p.OOMScoreAdj != 1000 {
		t.Fatalf("oom_score_adj must be 1000 before Landlock applies, got %d", p.OOMScoreAdj)
	}
	want := map[string]string{
		"read /etc/hostname":      "EACCES",
		"read /proc/self/environ": "EACCES",
		"write /tmp":              "EACCES",
		"dial udp":                "EPERM",
		"dial unix":               "EPERM",
		"ptrace parent":           "EPERM",
		"process_vm_readv parent": "EPERM",
		"signal parent":           "EPERM",
		"exec /bin/sh":            "EPERM",
	}
	got := map[string]string{}
	for _, pr := range p.Probes {
		if !pr.Denied {
			t.Errorf("probe %q was NOT denied", pr.Name)
		}
		got[pr.Name] = pr.Errno
	}
	for name, errno := range want {
		if got[name] != errno {
			t.Errorf("probe %q: want %s, got %q", name, errno, got[name])
		}
	}
}

// Control: the same probes WITHOUT the sandbox succeed, so the denials above
// are the sandbox's doing and not an artefact of the environment.
func TestSandboxProbesSucceedWithoutSandbox(t *testing.T) {
	bin := buildCgoFreeYarac(t)
	_, p, stderr := runProbe(t, bin, "--control")
	if p.Sandboxed {
		t.Fatalf("--control must not sandbox: %+v", p)
	}
	allowed := map[string]bool{}
	for _, pr := range p.Probes {
		allowed[pr.Name] = !pr.Denied
	}
	for _, name := range []string{"read /proc/self/environ", "write /tmp", "dial udp", "signal parent"} {
		if !allowed[name] {
			t.Errorf("control probe %q should succeed unsandboxed: %+v stderr=%s", name, p, stderr)
		}
	}
}

func TestSandboxMatchStillScans(t *testing.T) {
	bin := buildCgoFreeYarac(t)
	golden, err := os.ReadFile(iocGoldenPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "match", "--filename", "sample.bin")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")} // what the API passes in production
	cmd.Stdin = bytes.NewReader(frame(golden, []byte("xx breeze_ioc_golden_marker xx")))
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("sandboxed match failed: %v stdout=%s stderr=%s", err, stdout.String(), stderr.String())
	}
	m := parseMatch(t, stdout.String())
	if !m.OK || len(m.Matches) != 1 || len(m.Matches[0].MatchedStrings) != 1 {
		t.Fatalf("sandboxed match must still find the golden marker: %s", stdout.String())
	}
}
