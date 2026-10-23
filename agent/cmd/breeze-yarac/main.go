// Command breeze-yarac validates, compiles and test-scans Breeze YARA rule
// bundles with the exact compile policy the agent enforces (package
// internal/yarascan/yarac). Uses:
//
//   - validate: the W03 server-side pre-check (reads a bundle on stdin,
//     prints the C5 per-rule error JSON);
//   - compile:  CI and the lab benchmark (never shipped to agents — agents
//     compile on device);
//   - scan:     the lab benchmark harness (drives the agent's own worker-pool
//     walk);
//   - match:    the W04 rule test upload (#6267): scans ONE in-memory sample
//     inside a Landlock + seccomp sandbox (see enterSandbox);
//   - sandbox-check: applies that sandbox and probes it (operators, tests and
//     the image proof);
//   - version:  engine/policy/format identification for diagnostics.
//
// Exit codes: 0 ok, 1 rule/bundle errors (JSON on stdout), 2 usage, I/O, or
// engine/scan failure,
// 3 sandbox unavailable (match / sandbox-check: nothing was scanned),
// 4 sandbox-check: the sandbox applied but a probe was not denied.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
	"github.com/breeze-rmm/agent/internal/yarascan"
	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

const (
	exitOK           = 0
	exitRules        = 1
	exitUsage        = 2
	exitSandbox      = 3
	exitSandboxLeaky = 4
)

const (
	// maxSampleBytes mirrors the API's YARA_TEST_SAMPLE_MAX_BYTES (10 MiB).
	maxSampleBytes = 10 << 20
	// matchScanTimeout bounds the engine on one sample (the API kills the
	// child at 30 s, which also covers the ~10 s engine start-up).
	matchScanTimeout = 15 * time.Second
	// unsandboxedEnv skips the sandbox for `match`. The API sets it only when
	// its NODE_ENV is development/test (macOS dev boxes have no Landlock).
	unsandboxedEnv = "BREEZE_YARA_TEST_UNSANDBOXED"
)

var errSandboxUnavailable = errors.New("sandbox unavailable")

// sandboxState is what the sandbox applied (reported by sandbox-check).
type sandboxState struct {
	Sandboxed   bool `json:"sandboxed"`
	LandlockABI int  `json:"landlockAbi"`
	OOMScoreAdj int  `json:"oomScoreAdj"`
}

type probeResult struct {
	Name   string `json:"name"`
	Denied bool   `json:"denied"`
	Errno  string `json:"errno,omitempty"`
	Error  string `json:"error,omitempty"`
}

const usage = `usage:
  breeze-yarac validate < bundle.json
  breeze-yarac compile --out rules.bin bundle.json [bundle.json ...]
  breeze-yarac scan --bundle b.json [--bundle b2.json] [--workers N] [--max-file-mb 50] <path> [<path> ...]
  breeze-yarac match --filename NAME [--filepath PATH] < frame
      frame = 4-byte big-endian bundle length, the bundle JSON, then the sample to EOF
  breeze-yarac sandbox-check [--control]
  breeze-yarac version
`

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return exitUsage
	}
	switch args[0] {
	case "validate":
		return cmdValidate(args[1:], stdin, stdout, stderr)
	case "compile":
		return cmdCompile(args[1:], stdout, stderr)
	case "scan":
		return cmdScan(args[1:], stdout, stderr)
	case "match":
		return cmdMatch(args[1:], stdin, stdout, stderr)
	case "sandbox-check":
		return cmdSandboxCheck(args[1:], stdout, stderr)
	case sandboxedSubcommand:
		return cmdSandboxed(args[1:], stdin, stdout, stderr)
	case "version":
		return writeJSON(stdout, stderr, map[string]any{"engine": yarac.EngineVersion(), "policy": yarac.PolicyVersion, "format": yarascan.BundleFormatVersion})
	case "-h", "--help", "help":
		_, _ = fmt.Fprint(stdout, usage)
		return exitOK
	default:
		_, _ = fmt.Fprintf(stderr, "unknown subcommand %q\n%s", args[0], usage)
		return exitUsage
	}
}

// validateResult is the C5 contract W03's pre-check parses.
type validateResult struct {
	OK     bool              `json:"ok"`
	Errors []yarac.RuleError `json:"errors"`
}

func writeJSON(stdout, stderr io.Writer, v any) int {
	enc := json.NewEncoder(stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		_, _ = fmt.Fprintf(stderr, "write output: %v\n", err)
		return exitUsage
	}
	return exitOK
}

var errInputTooLarge = fmt.Errorf("bundle exceeds %d bytes", yarascan.MaxBundleBytes)

func readBounded(r io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, yarascan.MaxBundleBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > yarascan.MaxBundleBytes {
		return nil, errInputTooLarge
	}
	return body, nil
}

func cmdValidate(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		_, _ = fmt.Fprintf(stderr, "validate takes no arguments; the bundle is read from stdin\n%s", usage)
		return exitUsage
	}
	body, err := readBounded(stdin)
	if errors.Is(err, errInputTooLarge) {
		writeJSON(stdout, stderr, validateResult{Errors: []yarac.RuleError{{Code: yarascan.CodeBundleInvalid, Message: err.Error()}}})
		return exitRules
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "read stdin: %v\n", err)
		return exitUsage
	}
	// No sha256 pin: the caller is the server that just built these bytes.
	b, err := yarascan.DecodeBundle(body)
	if err != nil {
		writeJSON(stdout, stderr, validateResult{Errors: []yarac.RuleError{{Code: yarascan.CodeBundleInvalid, Message: err.Error()}}})
		return exitRules
	}
	errs := yarac.ValidateSet(yarascan.ToYaracSet(b), yarac.DefaultPolicy)
	if errs == nil {
		errs = []yarac.RuleError{}
	}
	if code := writeJSON(stdout, stderr, validateResult{OK: len(errs) == 0, Errors: errs}); code != exitOK {
		return code
	}
	return rulesExitCode(errs, stderr)
}

// rulesExitCode: 1 for rule errors, but 2 when the ENGINE failed — the
// server pre-check must never tell a rule author their rules are invalid
// because the compiler itself could not run.
func rulesExitCode(errs []yarac.RuleError, stderr io.Writer) int {
	if len(errs) == 0 {
		return exitOK
	}
	for _, e := range errs {
		if e.Code == yarac.CodeEngine {
			_, _ = fmt.Fprintf(stderr, "YARA engine failure: %s\n", e.Message)
			return exitUsage
		}
	}
	return exitRules
}

func loadBundles(paths []string) ([]*yarascan.Bundle, error) {
	var out []*yarascan.Bundle
	seen := map[string]string{}
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			return nil, err
		}
		body, err := readBounded(f)
		_ = f.Close()
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		b, err := yarascan.DecodeBundle(body)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		if prev, dup := seen[b.RuleSetID]; dup {
			return nil, fmt.Errorf("%s: ruleSetId %s already loaded from %s", p, b.RuleSetID, prev)
		}
		seen[b.RuleSetID] = p
		out = append(out, b)
	}
	return out, nil
}

// compileBundles compiles bundles into one matcher entry; any set with
// errors is reported (exit 1), mirroring the agent's whole-set rejection.
func compileBundles(bundles []*yarascan.Bundle, stdout, stderr io.Writer) (*yarascan.CacheEntry, int) {
	sets := make([]yarac.Set, 0, len(bundles))
	for _, b := range bundles {
		sets = append(sets, yarascan.ToYaracSet(b))
	}
	rules, setErrs, err := yarac.CompileSets(sets, yarac.DefaultPolicy)
	if len(setErrs) > 0 {
		var all []yarac.RuleError
		for _, b := range bundles {
			all = append(all, setErrs[b.RuleSetID]...)
		}
		if code := writeJSON(stdout, stderr, validateResult{Errors: all}); code != exitOK {
			return nil, code
		}
		return nil, rulesExitCode(all, stderr)
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "compile: %v\n", err)
		return nil, exitUsage
	}
	if rules == nil {
		_, _ = fmt.Fprintln(stderr, "compile: no rules")
		return nil, exitUsage
	}
	entry := &yarascan.CacheEntry{Rules: rules, Index: map[string]yarascan.RuleMeta{}, AutoQuarantine: map[string]bool{}}
	for _, b := range bundles {
		entry.AutoQuarantine[b.RuleSetID] = b.AutoQuarantine
		for _, r := range b.Rules {
			entry.Index[b.RuleSetID+":"+r.Name] = yarascan.RuleMeta{RuleID: r.ID, Severity: r.Severity}
		}
	}
	return entry, exitOK
}

func cmdCompile(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("compile", flag.ContinueOnError)
	fs.SetOutput(stderr)
	out := fs.String("out", "", "output file for the serialized compiled rules")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if *out == "" || fs.NArg() == 0 {
		_, _ = fmt.Fprintf(stderr, "compile needs --out and at least one bundle\n%s", usage)
		return exitUsage
	}
	bundles, err := loadBundles(fs.Args())
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return exitUsage
	}
	entry, code := compileBundles(bundles, stdout, stderr)
	if code != exitOK {
		return code
	}
	f, err := os.OpenFile(*out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return exitUsage
	}
	n, werr := entry.Rules.WriteTo(f)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_, _ = fmt.Fprintln(stderr, werr)
		return exitUsage
	}
	return writeJSON(stdout, stderr, map[string]any{"ok": true, "rules": entry.Rules.Count(), "bytes": n})
}

type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

type scanMatch struct {
	Path           string                   `json:"path"`
	RuleSetID      string                   `json:"ruleSetId"`
	RuleName       string                   `json:"ruleName"`
	RuleID         string                   `json:"ruleId"`
	Severity       string                   `json:"severity"`
	Type           string                   `json:"type"`
	SHA256         string                   `json:"sha256,omitempty"`
	MatchedStrings []yarascan.MatchedString `json:"matchedStrings,omitempty"`
}

type scanSummary struct {
	FilesScanned int    `json:"filesScanned"`
	FilesFailed  int    `json:"filesFailed"`
	Matches      int    `json:"matches"`
	CompileMs    int64  `json:"compileMs"`
	DurationMs   int64  `json:"durationMs"`
	Workers      int    `json:"workers"`
	PeakGoSysMb  uint64 `json:"peakGoSysMb"`
	PeakRssMb    uint64 `json:"peakRssMb"`
	Engine       string `json:"engine"`
	Error        string `json:"error,omitempty"`
}

func cmdScan(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("scan", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var bundlePaths stringList
	fs.Var(&bundlePaths, "bundle", "bundle JSON file (repeatable)")
	workers := fs.Int("workers", 0, "scan workers (default: the agent's min(NumCPU/2, 4))")
	maxFileMb := fs.Int("max-file-mb", 0, "skip files larger than this (default: the agent default, 25)")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if len(bundlePaths) == 0 || fs.NArg() == 0 {
		_, _ = fmt.Fprintf(stderr, "scan needs at least one --bundle and one path\n%s", usage)
		return exitUsage
	}
	if *workers < 0 || *maxFileMb < 0 {
		_, _ = fmt.Fprintln(stderr, "--workers and --max-file-mb must be >= 0")
		return exitUsage
	}
	bundles, err := loadBundles(bundlePaths)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return exitUsage
	}

	var peakSys atomic.Uint64
	stop := make(chan struct{})
	sampled := make(chan struct{})
	go func() { // Go-runtime view only; wasm linear memory is in Go heap via wazero, OS RSS below is authoritative
		defer close(sampled)
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		var ms runtime.MemStats
		for {
			runtime.ReadMemStats(&ms)
			if ms.Sys > peakSys.Load() {
				peakSys.Store(ms.Sys)
			}
			select {
			case <-stop:
				return
			case <-t.C:
			}
		}
	}()

	compileStart := time.Now()
	entry, code := compileBundles(bundles, stdout, stderr)
	compileMs := time.Since(compileStart).Milliseconds()
	if code != exitOK {
		close(stop)
		<-sampled
		return code
	}
	m := yarascan.NewMatcherFromEntry(entry)
	opts := security.WalkOptions{Workers: *workers, MaxFileSize: int64(*maxFileMb) << 20}
	scanStart := time.Now()
	res, scanErr := security.WalkAndMatch(context.Background(), fs.Args(), m, opts)
	duration := time.Since(scanStart)
	close(stop)
	<-sampled

	enc := json.NewEncoder(stdout)
	enc.SetEscapeHTML(false)
	for _, th := range res.Threats {
		if err := enc.Encode(scanMatch{Path: th.Path, RuleSetID: th.RuleSetID, RuleName: th.RuleName, RuleID: th.RuleID,
			Severity: th.Severity, Type: th.Type, SHA256: th.SHA256, MatchedStrings: th.MatchedStrings}); err != nil {
			_, _ = fmt.Fprintf(stderr, "write output: %v\n", err)
			return exitUsage
		}
	}
	effWorkers := *workers
	if effWorkers == 0 {
		effWorkers = min(max(runtime.NumCPU()/2, 1), 4)
	}
	sum := scanSummary{FilesScanned: res.FilesScanned, FilesFailed: res.FilesFailed, Matches: len(res.Threats),
		CompileMs: compileMs, DurationMs: duration.Milliseconds(), Workers: effWorkers,
		PeakGoSysMb: peakSys.Load() >> 20, PeakRssMb: peakRSSBytes() >> 20, Engine: m.Engine()}
	if scanErr == nil && res.FilesScanned == 0 {
		// Nothing scanned (bad path, everything excluded or unreadable):
		// a benchmark must not read that as a clean run.
		scanErr = fmt.Errorf("no files were scanned (%d failed)", res.FilesFailed)
	}
	if scanErr != nil {
		sum.Error = scanErr.Error()
	}
	if code := writeJSON(stdout, stderr, sum); code != exitOK {
		return code
	}
	if scanErr != nil {
		return exitUsage
	}
	return exitOK
}

// --- match (#6267 W04-2) -----------------------------------------------------

type matchedRule struct {
	RuleSetID      string                   `json:"ruleSetId"`
	RuleID         string                   `json:"ruleId"`
	RuleName       string                   `json:"ruleName"`
	Severity       string                   `json:"severity"`
	Tags           []string                 `json:"tags"`
	MatchedStrings []yarascan.MatchedString `json:"matchedStrings"`
}

type matchResult struct {
	OK         bool          `json:"ok"`
	Matches    []matchedRule `json:"matches"`
	DurationMs int64         `json:"durationMs"`
	PeakRssMb  uint64        `json:"peakRssMb"`
}

type matchOptions struct{ filename, virtualPath string }

func parseMatchFlags(args []string, stderr io.Writer) (matchOptions, int) {
	fs := flag.NewFlagSet("match", flag.ContinueOnError)
	fs.SetOutput(stderr)
	filename := fs.String("filename", "", "the sample's file name (sets the filename and extension globals)")
	virtualPath := fs.String("filepath", "", "the path the file would have on a device (filepath global; default: the filename)")
	if err := fs.Parse(args); err != nil {
		return matchOptions{}, exitUsage
	}
	if *filename == "" || fs.NArg() != 0 {
		_, _ = fmt.Fprintf(stderr, "match needs --filename and reads its input from stdin\n%s", usage)
		return matchOptions{}, exitUsage
	}
	return matchOptions{filename: *filename, virtualPath: *virtualPath}, exitOK
}

// sandboxUnavailable is exit 3: `{"ok":false,"unavailable":"sandbox"}` on
// stdout (what the API maps to 503 YARA_TEST_SANDBOX_UNAVAILABLE) and the
// failed step on stderr. Nothing was scanned.
func sandboxUnavailable(err error, stdout, stderr io.Writer) int {
	_, _ = fmt.Fprintf(stderr, "%v\n", err)
	writeJSON(stdout, stderr, map[string]any{"ok": false, "unavailable": "sandbox"})
	return exitSandbox
}

// cmdMatch scans one uploaded sample against one bundle, in memory, inside
// the sandbox (enterSandbox re-executes this binary sandboxed; the sandboxed
// process reads stdin and scans). The sample is never written to disk.
func cmdMatch(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	opts, code := parseMatchFlags(args, stderr)
	if code != exitOK {
		return code
	}
	if os.Getenv(unsandboxedEnv) == "1" {
		return runMatch(opts, stdin, stdout, stderr)
	}
	// Returns only when a sandbox step failed.
	return sandboxUnavailable(enterSandbox("match", args), stdout, stderr)
}

// runMatch reads the frame (4-byte big-endian bundle length, bundle, sample
// to EOF), then engine init → decode + compile → scan.
func runMatch(opts matchOptions, stdin io.Reader, stdout, stderr io.Writer) int {
	var hdr [4]byte
	if _, err := io.ReadFull(stdin, hdr[:]); err != nil {
		_, _ = fmt.Fprintf(stderr, "read frame header: %v\n", err)
		return exitUsage
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > yarascan.MaxBundleBytes {
		_, _ = fmt.Fprintf(stderr, "bundle length %d is outside 1..%d\n", n, yarascan.MaxBundleBytes)
		return exitUsage
	}
	bundle := make([]byte, n)
	if _, err := io.ReadFull(stdin, bundle); err != nil {
		_, _ = fmt.Fprintf(stderr, "read bundle: %v\n", err)
		return exitUsage
	}
	sample, err := io.ReadAll(io.LimitReader(stdin, maxSampleBytes+1))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "read sample: %v\n", err)
		return exitUsage
	}
	if len(sample) > maxSampleBytes {
		_, _ = fmt.Fprintf(stderr, "sample exceeds %d bytes\n", maxSampleBytes)
		return exitUsage
	}

	start := time.Now()
	if err := yarac.EnsureEngine(); err != nil {
		_, _ = fmt.Fprintf(stderr, "YARA engine failure: %v\n", err)
		return exitUsage
	}
	b, err := yarascan.DecodeBundle(bundle)
	if err != nil {
		writeJSON(stdout, stderr, validateResult{Errors: []yarac.RuleError{{Code: yarascan.CodeBundleInvalid, Message: err.Error()}}})
		return exitRules
	}
	entry, code := compileBundles([]*yarascan.Bundle{b}, stdout, stderr)
	if code != exitOK {
		return code
	}
	matches, err := yarascan.ScanSample(entry, opts.filename, opts.virtualPath, sample, matchScanTimeout)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "scan: %v\n", err)
		return exitUsage
	}
	res := matchResult{OK: true, Matches: make([]matchedRule, 0, len(matches)), DurationMs: time.Since(start).Milliseconds()}
	for _, m := range matches {
		r := matchedRule{RuleSetID: m.RuleSetID, RuleID: m.RuleID, RuleName: m.RuleName, Severity: m.Severity,
			Tags: m.Tags, MatchedStrings: m.Strings}
		if r.Tags == nil {
			r.Tags = []string{}
		}
		if r.MatchedStrings == nil {
			r.MatchedStrings = []yarascan.MatchedString{}
		}
		res.Matches = append(res.Matches, r)
	}
	res.PeakRssMb = peakRSSBytes() >> 20
	return writeJSON(stdout, stderr, res)
}

// cmdSandboxCheck applies match's sandbox and reports what a compromised
// engine could still do (operators, tests, the image proof). `--control`
// runs the same probes unsandboxed so a test can show the denials are the
// sandbox's doing. Never honours BREEZE_YARA_TEST_UNSANDBOXED.
func cmdSandboxCheck(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("sandbox-check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	control := fs.Bool("control", false, "run the probes WITHOUT the sandbox")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return exitUsage
	}
	if *control {
		writeJSON(stdout, stderr, map[string]any{"ok": true, "sandboxed": false, "probes": runProbes(true)})
		return exitOK
	}
	return sandboxUnavailable(enterSandbox("sandbox-check", nil), stdout, stderr)
}

// reportProbes runs in the sandboxed process: exit 0 only when every probe
// was denied, 4 when the sandbox applied but something got through.
func reportProbes(st sandboxState, stdout, stderr io.Writer) int {
	probes := runProbes(false)
	ok := len(probes) > 0
	for _, p := range probes {
		ok = ok && p.Denied
	}
	writeJSON(stdout, stderr, map[string]any{"ok": ok, "sandboxed": st.Sandboxed, "landlockAbi": st.LandlockABI,
		"oomScoreAdj": st.OOMScoreAdj, "probes": probes})
	if !ok {
		return exitSandboxLeaky
	}
	return exitOK
}
