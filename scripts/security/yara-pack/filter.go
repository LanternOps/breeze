// Command filter turns a pinned YARA Forge rule package into the Breeze
// built-in detection-rule bundle (#6263 W03b, spec §5 step 5).
//
// Input: the single `yara-rules-core.yar` file from a YARA Forge "core"
// release (build-pack.sh downloads and sha256-verifies it). Output: one
// canonical W02 §C2 bundle with ruleSetId = BuiltinRuleSetID, plus a
// deterministic pack report listing every rule kept or dropped and why.
//
// A rule is kept only when ALL of these hold:
//   - its licence is on LICENSES.allow — the repository licence YARA Forge
//     embeds per rule set AND any per-rule `meta: license`, so a DRL rule in a
//     BSD repository is still dropped. Missing licence = dropped;
//   - it is not private/global (each bundle source must hold exactly one
//     standalone rule, W02 §C2);
//   - it is not on denylist.txt (the clean-corpus false-positive fix path);
//   - it uses only modules the agent engine provides (W02 Task 1 spike);
//   - its Forge score is at least -min-score (the pack auto-quarantines, D7);
//   - `breeze-yarac validate` — the agent's own compiler and policy — accepts it.
//
// Selection is deterministic: quality desc, score desc, name asc, greedily
// filled up to the C5 caps (500 rules, 10 000 strings). Rule ids are
// UUIDv5(namespace = BuiltinRuleSetID, name = rule name), so a rule keeps its
// id across pack versions.
//
// Stdlib only, on purpose: this runs in CI and the release workflow with no
// module downloads.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// BuiltinRuleSetID mirrors YARA_BUILTIN_RULE_SET_ID in
// packages/shared/src/types/yara.ts (the boot upsert rejects any other id).
const BuiltinRuleSetID = "00000000-0000-4000-8000-00000000b001"

const (
	bundleFormat        = "breeze-yara-bundle"
	bundleFormatVersion = 1
	reportFormat        = "breeze-yara-pack-report"
	reportFormatVersion = 1

	// W02 §C5 caps (yarac.DefaultPolicy); the bundle must also fit 16 MiB.
	defaultMaxRules      = 500
	defaultStringsCap    = 10000
	maxRuleSourceBytes   = 64 << 10
	maxBundleBytes       = 16 << 20
	maxNameLen           = 128
	maxValidateRounds    = 64
	validateTimeout      = 10 * time.Minute
	maxReportDetailChars = 300
)

// Licence classes that are never SPDX ids we accept.
const (
	licenseNone    = "NONE"
	licenseUnknown = "UNRECOGNIZED"
	licenseDefer   = "DEFER" // per-rule meta that only points at the repository licence
)

// permissiveSPDX is the ceiling for LICENSES.allow: an allowlist line naming
// anything else (GPL, DRL, Elastic, CC-BY…) is a configuration error, not a
// silent widening.
var permissiveSPDX = map[string]bool{
	"Apache-2.0":   true,
	"MIT":          true,
	"BSD-2-Clause": true,
	"BSD-3-Clause": true,
	"CC0-1.0":      true,
}

// Modules the agent's yaraxwasm build provides (W02 Task 1 spike: pe, elf,
// hash, math present). dotnet is not covered by the spike; it is allowed here
// and breeze-yarac validate is the arbiter. Anything else is dropped.
var allowedModules = map[string]bool{"pe": true, "elf": true, "hash": true, "math": true, "dotnet": true}

// Module names looked for in a rule's condition.
var knownModules = []string{"console", "cuckoo", "dex", "dotnet", "elf", "hash", "lnk", "macho", "magic", "math", "pe", "string", "time"}

var (
	ruleNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	ruleHeaderRe    = regexp.MustCompile(`^((?:(?:private|global)\s+)*)rule\s+([A-Za-z_][A-Za-z0-9_]*)\b`)
	importRe        = regexp.MustCompile(`^import\s+"([a-z0-9_]+)"\s*$`)
	metaLineRe      = regexp.MustCompile(`^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$`)
	stringDefRe     = regexp.MustCompile(`^\s*\$[A-Za-z0-9_]*\s*=`)
	capStringsMsgRe = regexp.MustCompile(`^(\d+) strings exceeds the cap of (\d+)`)
	drlWordRe       = regexp.MustCompile(`\bdrl\b`)
	gplWordRe       = regexp.MustCompile(`\b[al]?gpl\b`)
	ccBy4Re         = regexp.MustCompile(`\bcc[ -]by[ -]4\.0\b|creative commons attribution 4\.0`)
	bsd2Re          = regexp.MustCompile(`\bbsd[ -]?2[ -]clause\b|2-clause bsd`)
	bsd3Re          = regexp.MustCompile(`\bbsd[ -]?3[ -]clause\b|3-clause bsd|neither the name|(?m)^\s*3\.\s`)
)

// ErrTooFewRules is the sanity floor: a licence-classifier or parser regression
// must fail the build, not ship a near-empty pack.
var ErrTooFewRules = errors.New("too few rules survived the filter")

// Config is one pack build.
type Config struct {
	ForgeTag     string
	ForgeSHA256  string
	PackVersion  int
	Allowed      map[string]bool
	Denylist     map[string]string
	YaracPath    string
	MaxRules     int
	StringsCap   int
	MinScore     int
	MinKeptRules int
}

// Bundle is W02 §C2. Field order is the canonical key order.
type Bundle struct {
	Format         string       `json:"format"`
	V              int          `json:"v"`
	RuleSetID      string       `json:"ruleSetId"`
	Version        int          `json:"version"`
	AutoQuarantine bool         `json:"autoQuarantine"`
	Rules          []BundleRule `json:"rules"`
}

// BundleRule is one W02 §C2 rule.
type BundleRule struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Severity string `json:"severity"`
	Source   string `json:"source"`
}

// Report is the deterministic pack report (no timestamps).
type Report struct {
	Format       string        `json:"format"`
	V            int           `json:"v"`
	PackVersion  int           `json:"packVersion"`
	RuleSetID    string        `json:"ruleSetId"`
	BundleSHA256 string        `json:"bundleSha256"`
	BundleBytes  int           `json:"bundleBytes"`
	Forge        ForgeInfo     `json:"forge"`
	Caps         Caps          `json:"caps"`
	Counts       Counts        `json:"counts"`
	Repositories []RepoReport  `json:"repositories"`
	Kept         []KeptRule    `json:"kept"`
	Dropped      []DroppedRule `json:"dropped"`
}

type ForgeInfo struct {
	Tag    string `json:"tag"`
	SHA256 string `json:"sha256"`
}

type Caps struct {
	MaxRules      int      `json:"maxRules"`
	StringsCap    int      `json:"stringsCap"`
	StringsBudget int      `json:"stringsBudget"`
	MinScore      int      `json:"minScore"`
	Licenses      []string `json:"licenses"`
	Modules       []string `json:"modules"`
}

type Counts struct {
	Parsed  int            `json:"parsed"`
	Kept    int            `json:"kept"`
	Dropped map[string]int `json:"dropped"`
}

type RepoReport struct {
	Name              string `json:"name"`
	URL               string `json:"url"`
	License           string `json:"license"`
	LicenseTextSHA256 string `json:"licenseTextSha256"`
	LicenseText       string `json:"licenseText"`
	Parsed            int    `json:"parsed"`
	Kept              int    `json:"kept"`
}

type KeptRule struct {
	Name       string `json:"name"`
	ID         string `json:"id"`
	Severity   string `json:"severity"`
	License    string `json:"license"`
	Repository string `json:"repository"`
	Score      int    `json:"score"`
	Quality    int    `json:"quality"`
	Strings    int    `json:"strings"`
}

type DroppedRule struct {
	Name       string `json:"name"`
	Repository string `json:"repository"`
	Reason     string `json:"reason"`
	Detail     string `json:"detail,omitempty"`
}

// Result is a finished build.
type Result struct {
	Bundle []byte
	SHA256 string
	Report Report
}

type repoSection struct {
	Name        string
	URL         string
	LicenseText string
	SPDX        string
	parsed      int
	kept        int
}

type forgeRule struct {
	Name       string
	Modifiers  string
	Text       string
	Condition  string
	Meta       map[string][]string
	Strings    int
	Repo       *repoSection
	ParseError string

	// Filled by the static filter.
	License  string
	Score    int
	HasScore bool
	Quality  int
	Source   string
	ID       string
	Severity string
}

func repoName(r *forgeRule) string {
	if r.Repo == nil {
		return ""
	}
	return r.Repo.Name
}

// ---- parsing ---------------------------------------------------------------

func parseForge(src []byte) ([]*forgeRule, []*repoSection) {
	text := strings.ReplaceAll(string(src), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	var rules []*forgeRule
	var repos []*repoSection
	var current *repoSection

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "/*" && i+1 < len(lines) && strings.TrimSpace(lines[i+1]) == "* YARA Rule Set" {
			end := i + 2
			for end < len(lines) && strings.TrimSpace(lines[end]) != "*/" {
				end++
			}
			current = parseRepoBlock(lines[i+2 : min(end, len(lines))])
			repos = append(repos, current)
			i = end
			continue
		}
		m := ruleHeaderRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		r := &forgeRule{Name: m[2], Modifiers: strings.TrimSpace(m[1]), Repo: current, Meta: map[string][]string{}}
		rules = append(rules, r)
		if current != nil {
			current.parsed++
		}
		end := -1
		for j := i + 1; j < len(lines); j++ {
			if ruleHeaderRe.MatchString(lines[j]) {
				break
			}
			if strings.TrimRight(lines[j], " \t") == "}" {
				end = j
				break
			}
		}
		if end < 0 {
			r.ParseError = "no closing brace before the next rule"
			continue
		}
		body := lines[i : end+1]
		r.Text = strings.Join(body, "\n")
		parseRuleBody(r, body)
		i = end
	}
	return rules, repos
}

func parseRepoBlock(block []string) *repoSection {
	s := &repoSection{}
	var lic []string
	inLicense := false
	for _, l := range block {
		stripped := strings.TrimPrefix(strings.TrimPrefix(l, " *"), " ")
		if inLicense {
			lic = append(lic, stripped)
			continue
		}
		switch {
		case strings.HasPrefix(stripped, "Repository Name: "):
			s.Name = strings.TrimSpace(strings.TrimPrefix(stripped, "Repository Name: "))
		case strings.HasPrefix(stripped, "Repository: "):
			s.URL = strings.TrimSpace(strings.TrimPrefix(stripped, "Repository: "))
		case strings.TrimSpace(stripped) == "LICENSE":
			inLicense = true
		}
	}
	s.LicenseText = strings.TrimSpace(strings.Join(lic, "\n"))
	s.SPDX = classifyLicenseText(s.LicenseText)
	return s
}

func parseRuleBody(r *forgeRule, body []string) {
	section := ""
	var cond []string
	for _, l := range body[1:] {
		switch strings.TrimSpace(l) {
		case "meta:":
			section = "meta"
			continue
		case "strings:":
			section = "strings"
			continue
		case "condition:":
			section = "condition"
			continue
		}
		switch section {
		case "meta":
			if m := metaLineRe.FindStringSubmatch(l); m != nil {
				r.Meta[strings.ToLower(m[1])] = append(r.Meta[strings.ToLower(m[1])], unquoteMeta(m[2]))
			}
		case "strings":
			if stringDefRe.MatchString(l) {
				r.Strings++
			}
		case "condition":
			cond = append(cond, l)
		}
	}
	r.Condition = strings.Join(cond, "\n")
}

func unquoteMeta(v string) string {
	if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
		v = v[1 : len(v)-1]
		v = strings.ReplaceAll(v, `\"`, `"`)
		v = strings.ReplaceAll(v, `\\`, `\`)
	}
	return v
}

func metaInt(r *forgeRule, key string) (int, bool) {
	for _, v := range r.Meta[key] {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n, true
		}
	}
	return 0, false
}

// ---- licences --------------------------------------------------------------

// classifyLicenseText maps licence text (a repository LICENSE as YARA Forge
// embeds it, or a per-rule meta value) to an SPDX id or a reject class.
// Restrictive markers are checked FIRST so a DRL text — which reuses MIT's
// "Permission is hereby granted" wording — can never classify as MIT.
func classifyLicenseText(text string) string {
	t := strings.ToLower(text)
	trimmed := strings.TrimSpace(t)
	if trimmed == "" || trimmed == "no license set" || trimmed == "n/a" {
		return licenseNone
	}
	switch {
	case strings.Contains(t, "detection rule license") || drlWordRe.MatchString(t):
		return "DRL-1.1"
	case strings.Contains(t, "general public license") || gplWordRe.MatchString(t):
		return "GPL"
	case strings.Contains(t, "elastic license"):
		return "Elastic-2.0"
	case strings.Contains(t, "noncommercial") || strings.Contains(t, "non-commercial") || strings.Contains(t, "by-nc"):
		return "NonCommercial"
	case strings.Contains(t, "sharealike") || strings.Contains(t, "by-sa"):
		return "ShareAlike"
	case strings.Contains(t, "commons clause"):
		return "CommonsClause"
	}
	switch {
	case strings.Contains(t, "apache license") && strings.Contains(t, "2.0"):
		return "Apache-2.0"
	case strings.Contains(t, "cc0") || strings.Contains(t, "creative commons zero"):
		return "CC0-1.0"
	case ccBy4Re.MatchString(t):
		return "CC-BY-4.0"
	case strings.Contains(t, "redistribution and use in source and binary forms"):
		if bsd3Re.MatchString(t) && !strings.Contains(t, "2-clause") {
			return "BSD-3-Clause"
		}
		return "BSD-2-Clause"
	case bsd3Re.MatchString(t) && strings.Contains(t, "bsd"):
		return "BSD-3-Clause"
	case bsd2Re.MatchString(t):
		return "BSD-2-Clause"
	case trimmed == "mit" || strings.HasPrefix(trimmed, "mit license") || strings.Contains(t, "permission is hereby granted, free of charge"):
		return "MIT"
	}
	return licenseUnknown
}

// classifyLicenseMeta handles a per-rule `meta: license` value. A value that
// only points at the repository licence defers to it.
func classifyLicenseMeta(v string) string {
	t := strings.ToLower(strings.TrimSpace(v))
	if t == "" || strings.HasPrefix(t, "see license at") {
		return licenseDefer
	}
	if c := classifyLicenseText(v); c != licenseNone {
		return c
	}
	return licenseDefer
}

// ruleLicense returns the rule's effective licence ids, or a drop reason.
func ruleLicense(r *forgeRule, allowed map[string]bool) (string, string, string) {
	var ids []string
	seen := map[string]bool{}
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if r.Repo != nil && r.Repo.SPDX != licenseNone {
		add(r.Repo.SPDX)
	}
	for _, v := range r.Meta["license"] {
		if c := classifyLicenseMeta(v); c != licenseDefer {
			add(c)
		}
	}
	if len(ids) == 0 {
		return "", "license_missing", ""
	}
	for _, id := range ids {
		if !allowed[id] {
			return "", "license_not_allowed", strings.Join(ids, " + ")
		}
	}
	return strings.Join(ids, " + "), "", ""
}

// ---- config files ----------------------------------------------------------

// ParseLicenseAllowlist reads LICENSES.allow: one SPDX id per line, `#`
// comments. Ids outside the permissive ceiling are rejected.
func ParseLicenseAllowlist(r io.Reader) (map[string]bool, error) {
	out := map[string]bool{}
	sc := bufio.NewScanner(r)
	n := 0
	for sc.Scan() {
		n++
		line := strings.TrimSpace(stripComment(sc.Text()))
		if line == "" {
			continue
		}
		if !permissiveSPDX[line] {
			return nil, fmt.Errorf("LICENSES.allow line %d: %q is not a permissive licence this pipeline may ship", n, line)
		}
		out[line] = true
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, errors.New("LICENSES.allow lists no licences")
	}
	return out, nil
}

// ParseDenylist reads denylist.txt: `RULE_NAME  reason…` per line.
func ParseDenylist(r io.Reader) (map[string]string, error) {
	out := map[string]string{}
	sc := bufio.NewScanner(r)
	n := 0
	for sc.Scan() {
		n++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if !ruleNamePattern.MatchString(fields[0]) {
			return nil, fmt.Errorf("denylist.txt line %d: %q is not a YARA rule name", n, fields[0])
		}
		if len(fields) < 2 {
			return nil, fmt.Errorf("denylist.txt line %d: %s has no reason (format: RULE_NAME reason…)", n, fields[0])
		}
		out[fields[0]] = strings.Join(fields[1:], " ")
	}
	return out, sc.Err()
}

func stripComment(s string) string {
	if i := strings.Index(s, "#"); i >= 0 {
		return s[:i]
	}
	return s
}

// ---- rule assembly ---------------------------------------------------------

func severityForScore(score int, has bool) string {
	switch {
	case !has:
		return "high"
	case score >= 90:
		return "critical"
	case score >= 75:
		return "high"
	case score >= 60:
		return "medium"
	default:
		return "low"
	}
}

func usedModules(r *forgeRule) []string {
	var out []string
	for _, m := range knownModules {
		if regexp.MustCompile(`\b` + m + `\.`).MatchString(r.Condition) {
			out = append(out, m)
		}
	}
	return out
}

func copyrightLine(text string) string {
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		if strings.Contains(strings.ToLower(l), "copyright") {
			if len(l) > 200 {
				l = l[:200]
			}
			return l
		}
	}
	return ""
}

func commentSafe(s string) string {
	s = strings.ReplaceAll(s, "*/", "* /")
	s = strings.ReplaceAll(s, "/*", "/ *")
	return strings.ReplaceAll(s, "\n", " ")
}

// assembleSource makes one standalone rule source: an attribution comment
// (BSD/MIT/Apache notice retention travels with the rule text itself), the
// module imports the rule's condition uses, then the rule verbatim.
func assembleSource(r *forgeRule, mods []string) string {
	var b strings.Builder
	attribution := "Breeze built-in detection rules"
	if r.Repo != nil {
		attribution += ": " + r.Repo.Name
		if r.Repo.URL != "" {
			attribution += " (" + r.Repo.URL + ")"
		}
	}
	attribution += ", license " + r.License + "."
	if r.Repo != nil {
		if c := copyrightLine(r.Repo.LicenseText); c != "" {
			attribution += " " + c + "."
		}
	}
	attribution += " Full licence texts: breeze-yara-builtin-report.json in the Breeze release."
	b.WriteString("/* " + commentSafe(attribution) + " */\n")
	for _, m := range mods {
		b.WriteString(`import "` + m + `"` + "\n")
	}
	if len(mods) > 0 {
		b.WriteString("\n")
	}
	b.WriteString(r.Text)
	return b.String()
}

// canonicalSafe rejects text whose JSON encoding differs between Go and
// JavaScript's JSON.stringify (invalid UTF-8, U+2028/U+2029): the API re-derives
// the canonical bytes at boot and refuses a pack that does not match.
func canonicalSafe(s string) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, ' ') && !strings.ContainsRune(s, ' ')
}

// ---- UUIDv5 ----------------------------------------------------------------

func uuidV5(namespace, name string) string {
	ns, err := hex.DecodeString(strings.ReplaceAll(namespace, "-", ""))
	if err != nil || len(ns) != 16 {
		panic("uuidV5: bad namespace " + namespace)
	}
	h := sha1.New()
	h.Write(ns)
	h.Write([]byte(name))
	u := h.Sum(nil)[:16]
	u[6] = (u[6] & 0x0f) | 0x50
	u[8] = (u[8] & 0x3f) | 0x80
	x := hex.EncodeToString(u)
	return x[0:8] + "-" + x[8:12] + "-" + x[12:16] + "-" + x[16:20] + "-" + x[20:32]
}

// ---- encoding --------------------------------------------------------------

func encodeBundle(b Bundle) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // JSON.stringify does not escape <, >, &
	if err := enc.Encode(b); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ---- validation ------------------------------------------------------------

type ruleError struct {
	RuleID  string `json:"ruleId"`
	Name    string `json:"name"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// validate runs `breeze-yarac validate`. Rule errors come back as a list; an
// engine failure, usage error or unreadable output is a fatal error — a
// broken compiler must never be read as "every rule is invalid".
func validate(yaracPath string, bundle []byte) ([]ruleError, error) {
	ctx, cancel := context.WithTimeout(context.Background(), validateTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, yaracPath, "validate")
	cmd.Stdin = bytes.NewReader(bundle)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) {
			return nil, fmt.Errorf("breeze-yarac validate could not run: %w", err)
		}
		code = ee.ExitCode()
	}
	var res struct {
		OK     *bool       `json:"ok"`
		Errors []ruleError `json:"errors"`
	}
	switch code {
	case 0, 1:
		if jerr := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &res); jerr != nil || res.OK == nil {
			return nil, fmt.Errorf("breeze-yarac validate exit %d with unreadable output: %.200s", code, stdout.String())
		}
		if code == 0 && *res.OK {
			return nil, nil
		}
		if code == 1 && !*res.OK && len(res.Errors) > 0 {
			return res.Errors, nil
		}
		return nil, fmt.Errorf("breeze-yarac validate exit %d inconsistent with ok=%v errors=%d", code, *res.OK, len(res.Errors))
	default:
		return nil, fmt.Errorf("breeze-yarac validate failed (exit %d): %.300s", code, strings.TrimSpace(stderr.String()))
	}
}

// ---- build -----------------------------------------------------------------

func truncateDetail(s string) string {
	if len(s) > maxReportDetailChars {
		return s[:maxReportDetailChars]
	}
	return s
}

// Build runs the whole filter over one Forge package.
func Build(src []byte, cfg Config) (*Result, error) {
	if cfg.PackVersion < 1 {
		return nil, errors.New("pack version must be >= 1")
	}
	if cfg.MaxRules <= 0 || cfg.MaxRules > defaultMaxRules {
		return nil, fmt.Errorf("max rules must be 1..%d", defaultMaxRules)
	}
	if cfg.StringsCap <= 0 || cfg.StringsCap > defaultStringsCap {
		return nil, fmt.Errorf("strings cap must be 1..%d", defaultStringsCap)
	}
	if cfg.YaracPath == "" {
		return nil, errors.New("breeze-yarac path is required")
	}

	rules, repos := parseForge(src)
	if len(rules) == 0 {
		return nil, errors.New("no rules parsed from the Forge package")
	}
	dropped := map[string]DroppedRule{}
	drop := func(r *forgeRule, reason, detail string) {
		dropped[r.Name] = DroppedRule{Name: r.Name, Repository: repoName(r), Reason: reason, Detail: truncateDetail(detail)}
	}

	names := map[string]bool{}
	var pool []*forgeRule
	for _, r := range rules {
		if names[r.Name] {
			// Forge prefixes names per repository, so a duplicate is a
			// packaging fault; keep the first, drop the rest.
			dropped[r.Name+"#dup"] = DroppedRule{Name: r.Name, Repository: repoName(r), Reason: "duplicate_name"}
			continue
		}
		names[r.Name] = true
		if r.ParseError != "" {
			drop(r, "parse_error", r.ParseError)
			continue
		}
		if r.Modifiers != "" {
			drop(r, "private_or_global", r.Modifiers)
			continue
		}
		if reason, ok := cfg.Denylist[r.Name]; ok {
			drop(r, "denylist", reason)
			continue
		}
		lic, reason, detail := ruleLicense(r, cfg.Allowed)
		if reason != "" {
			drop(r, reason, detail)
			continue
		}
		r.License = lic
		if len(r.Name) > maxNameLen || !ruleNamePattern.MatchString(r.Name) {
			drop(r, "name_invalid", "")
			continue
		}
		if !canonicalSafe(r.Text) {
			drop(r, "source_encoding", "invalid UTF-8 or U+2028/U+2029")
			continue
		}
		mods := usedModules(r)
		bad := ""
		for _, m := range mods {
			if !allowedModules[m] {
				bad = m
				break
			}
		}
		if bad != "" {
			drop(r, "module_unsupported", bad)
			continue
		}
		r.Score, r.HasScore = metaInt(r, "score")
		r.Quality, _ = metaInt(r, "quality")
		if r.HasScore && r.Score < cfg.MinScore {
			drop(r, "score_below_min", strconv.Itoa(r.Score))
			continue
		}
		r.Source = assembleSource(r, mods)
		if len(r.Source) > maxRuleSourceBytes {
			drop(r, "source_too_large", strconv.Itoa(len(r.Source)))
			continue
		}
		r.ID = uuidV5(BuiltinRuleSetID, r.Name)
		r.Severity = severityForScore(r.Score, r.HasScore)
		pool = append(pool, r)
	}

	sort.SliceStable(pool, func(i, j int) bool {
		a, b := pool[i], pool[j]
		if a.Quality != b.Quality {
			return a.Quality > b.Quality
		}
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.Name < b.Name
	})

	budget := cfg.StringsCap
	rejected := map[string]bool{}
	var selected []*forgeRule
	var bundleBytes []byte
	for round := 0; ; round++ {
		if round >= maxValidateRounds {
			return nil, fmt.Errorf("validation did not converge after %d rounds", maxValidateRounds)
		}
		selected = selected[:0]
		est := 0
		for _, r := range pool {
			if rejected[r.Name] || len(selected) >= cfg.MaxRules || est+r.Strings > budget {
				continue
			}
			selected = append(selected, r)
			est += r.Strings
		}
		if len(selected) == 0 {
			return nil, fmt.Errorf("%w: none of %d eligible rules fit the caps", ErrTooFewRules, len(pool))
		}
		b := Bundle{Format: bundleFormat, V: bundleFormatVersion, RuleSetID: BuiltinRuleSetID, Version: cfg.PackVersion, AutoQuarantine: true}
		for _, r := range selected {
			b.Rules = append(b.Rules, BundleRule{ID: r.ID, Name: r.Name, Severity: r.Severity, Source: r.Source})
		}
		sort.Slice(b.Rules, func(i, j int) bool { return b.Rules[i].ID < b.Rules[j].ID })
		enc, err := encodeBundle(b)
		if err != nil {
			return nil, err
		}
		if len(enc) > maxBundleBytes {
			budget = est * 9 / 10
			continue
		}
		errs, err := validate(cfg.YaracPath, enc)
		if err != nil {
			return nil, err
		}
		if len(errs) == 0 {
			bundleBytes = enc
			break
		}
		byID := map[string]*forgeRule{}
		for _, r := range selected {
			byID[r.ID] = r
		}
		ruleLevel := false
		for _, e := range errs {
			if r, ok := byID[e.RuleID]; ok {
				rejected[r.Name] = true
				drop(r, "validate", e.Code+": "+e.Message)
				ruleLevel = true
			}
		}
		if ruleLevel {
			continue
		}
		if len(errs) == 1 && errs[0].Code == "cap_strings" {
			next := est * 9 / 10
			if m := capStringsMsgRe.FindStringSubmatch(errs[0].Message); m != nil {
				actual, _ := strconv.Atoi(m[1])
				limit, _ := strconv.Atoi(m[2])
				if actual > 0 {
					next = int(float64(est) * float64(limit) / float64(actual) * 0.95)
				}
			}
			if next >= est {
				next = est - 1
			}
			budget = next
			continue
		}
		return nil, fmt.Errorf("breeze-yarac validate reported bundle-level errors it cannot attribute to a rule: %+v", errs)
	}

	keptSet := map[string]bool{}
	for _, r := range selected {
		keptSet[r.Name] = true
	}
	for _, r := range pool {
		if !keptSet[r.Name] && !rejected[r.Name] {
			drop(r, "not_selected", "beyond the rule/strings caps by quality, score, name")
		}
	}
	if len(selected) < cfg.MinKeptRules {
		return nil, fmt.Errorf("%w: kept %d, floor %d", ErrTooFewRules, len(selected), cfg.MinKeptRules)
	}

	rep := Report{
		Format: reportFormat, V: reportFormatVersion, PackVersion: cfg.PackVersion, RuleSetID: BuiltinRuleSetID,
		BundleSHA256: sha256Hex(bundleBytes), BundleBytes: len(bundleBytes),
		Forge: ForgeInfo{Tag: cfg.ForgeTag, SHA256: cfg.ForgeSHA256},
		Caps:  Caps{MaxRules: cfg.MaxRules, StringsCap: cfg.StringsCap, StringsBudget: budget, MinScore: cfg.MinScore},
		Counts: Counts{Parsed: len(rules), Kept: len(selected), Dropped: map[string]int{}},
	}
	for l := range cfg.Allowed {
		rep.Caps.Licenses = append(rep.Caps.Licenses, l)
	}
	sort.Strings(rep.Caps.Licenses)
	for m := range allowedModules {
		rep.Caps.Modules = append(rep.Caps.Modules, m)
	}
	sort.Strings(rep.Caps.Modules)
	for _, r := range selected {
		if r.Repo != nil {
			r.Repo.kept++
		}
		rep.Kept = append(rep.Kept, KeptRule{Name: r.Name, ID: r.ID, Severity: r.Severity, License: r.License,
			Repository: repoName(r), Score: r.Score, Quality: r.Quality, Strings: r.Strings})
	}
	sort.Slice(rep.Kept, func(i, j int) bool { return rep.Kept[i].Name < rep.Kept[j].Name })
	for _, d := range dropped {
		rep.Dropped = append(rep.Dropped, d)
		rep.Counts.Dropped[d.Reason]++
	}
	sort.Slice(rep.Dropped, func(i, j int) bool {
		if rep.Dropped[i].Name != rep.Dropped[j].Name {
			return rep.Dropped[i].Name < rep.Dropped[j].Name
		}
		return rep.Dropped[i].Reason < rep.Dropped[j].Reason
	})
	for _, s := range repos {
		rep.Repositories = append(rep.Repositories, RepoReport{Name: s.Name, URL: s.URL, License: s.SPDX,
			LicenseTextSHA256: sha256Hex([]byte(s.LicenseText)), LicenseText: s.LicenseText, Parsed: s.parsed, Kept: s.kept})
	}
	sort.SliceStable(rep.Repositories, func(i, j int) bool { return rep.Repositories[i].Name < rep.Repositories[j].Name })
	return &Result{Bundle: bundleBytes, SHA256: rep.BundleSHA256, Report: rep}, nil
}

// ---- CLI -------------------------------------------------------------------

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "yara-pack filter:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("filter", flag.ContinueOnError)
	forge := fs.String("forge", "", "path to the YARA Forge yara-rules-core.yar")
	forgeTag := fs.String("forge-tag", "", "YARA Forge release tag (recorded in the report)")
	forgeSHA := fs.String("forge-sha256", "", "sha256 of the verified Forge release zip (recorded in the report)")
	licenses := fs.String("licenses", "", "path to LICENSES.allow")
	denylist := fs.String("denylist", "", "path to denylist.txt")
	yaracPath := fs.String("yarac", "", "path to breeze-yarac")
	version := fs.Int("version", 0, "pack version (pack.lock)")
	outBundle := fs.String("out-bundle", "", "bundle output path")
	outReport := fs.String("out-report", "", "report output path")
	maxRules := fs.Int("max-rules", defaultMaxRules, "rule cap")
	stringsCap := fs.Int("strings-cap", defaultStringsCap, "strings cap")
	minScore := fs.Int("min-score", 75, "minimum YARA Forge score (the pack auto-quarantines)")
	minRules := fs.Int("min-rules", 200, "fail the build when fewer rules survive")
	if err := fs.Parse(args); err != nil {
		return err
	}
	for name, v := range map[string]string{"forge": *forge, "forge-tag": *forgeTag, "forge-sha256": *forgeSHA, "licenses": *licenses,
		"denylist": *denylist, "yarac": *yaracPath, "out-bundle": *outBundle, "out-report": *outReport} {
		if v == "" {
			return fmt.Errorf("-%s is required", name)
		}
	}
	src, err := os.ReadFile(*forge)
	if err != nil {
		return err
	}
	lf, err := os.Open(*licenses)
	if err != nil {
		return err
	}
	allowed, err := ParseLicenseAllowlist(lf)
	lf.Close()
	if err != nil {
		return err
	}
	df, err := os.Open(*denylist)
	if err != nil {
		return err
	}
	deny, err := ParseDenylist(df)
	df.Close()
	if err != nil {
		return err
	}
	res, err := Build(src, Config{ForgeTag: *forgeTag, ForgeSHA256: *forgeSHA, PackVersion: *version, Allowed: allowed,
		Denylist: deny, YaracPath: *yaracPath, MaxRules: *maxRules, StringsCap: *stringsCap, MinScore: *minScore, MinKeptRules: *minRules})
	if err != nil {
		return err
	}
	report, err := json.MarshalIndent(res.Report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(*outBundle, res.Bundle, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(*outReport, append(report, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "yara-pack: v%d kept %d of %d rules (%d bytes, sha256 %s); dropped %v\n",
		res.Report.PackVersion, res.Report.Counts.Kept, res.Report.Counts.Parsed, len(res.Bundle), res.SHA256, res.Report.Counts.Dropped)
	return nil
}
