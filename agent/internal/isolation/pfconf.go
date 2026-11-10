package isolation

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// macOS attaches isolation to pf through an anchor (spec OD13 a′): the anchor
// has to be referenced from the main ruleset, and the only way to add that
// reference is a main-ruleset load, which destroys whatever other services or
// admins put there. So: validate first, load only when the reference is missing,
// and otherwise only ever touch our own anchor. Refusing costs coverage on an
// incompatible Mac; that is the trade the spec chose over breaking its Internet
// Sharing.
//
// This file is pure so the decisions run on every CI runner. pfconf_darwin.go
// supplies the real commands.
const (
	// pfAnchorPath is the only ruleset this package ever loads or flushes.
	pfAnchorPath = "com.breeze/isolation"
	// pfConfPath is what a main-ruleset load restores. It is never written.
	pfConfPath = "/etc/pf.conf"
	// pfInternetSharingAnchor is the service-inserted anchor /etc/pf.conf warns
	// about. It has a com.apple prefix but is not a com.apple/ sub-anchor.
	pfInternetSharingAnchor = "com.apple.internet-sharing"
	// pfHookLine is appended to /etc/pf.conf for the one main-ruleset load.
	pfHookLine = `anchor "` + pfAnchorPath + `"`
	// pfDropLabel names the anchor's block rule, so the negative probe can read
	// its packet counter and attribute a drop to Breeze.
	pfDropLabel = "breeze_drop"
)

// ErrIncompatible refuses an apply: the Mac's pf configuration cannot host the
// isolation anchor without damaging something or being bypassed. Nothing has
// been changed when it is returned. The manager reports it as
// mechanism_unavailable, with Reason, rather than as a failed apply.
type ErrIncompatible struct{ Reason string }

func (e ErrIncompatible) Error() string {
	return "pf configuration is incompatible with network isolation: " + e.Reason
}

// PFRunner is the boundary to the host: everything pf-related goes through it,
// so the tests can drive the full protocol with a fake and never touch pf.
type PFRunner interface {
	// Pfctl runs pfctl with args and stdin (empty for none). pfctl writes its
	// tokens and status to stderr, so the streams stay separate.
	Pfctl(stdin string, args ...string) (stdout, stderr string, err error)
	// ReadPFConf returns the contents of /etc/pf.conf.
	ReadPFConf() (string, error)
	// EgressInterfaces names every interface traffic could leave through: up,
	// not loopback, with an address. Not only the default route's: a second
	// NIC reaches its own network whatever the default route says.
	EgressInterfaces() ([]string, error)
}

// pfLiveState is the main ruleset as the kernel reports it right now.
type pfLiveState struct {
	Rules      string // pfctl -sn, then pfctl -sr
	Anchors    string // pfctl -sA
	Interfaces string // pfctl -sI -v
}

func readPFLive(r PFRunner) (pfLiveState, error) {
	read := func(args ...string) (string, error) {
		stdout, _, err := r.Pfctl("", args...)
		if err != nil {
			return "", fmt.Errorf("read the pf main ruleset (%s): %w", strings.Join(args, " "), err)
		}
		return stdout, nil
	}
	translation, err := read("-sn")
	if err != nil {
		return pfLiveState{}, err
	}
	filter, err := read("-sr")
	if err != nil {
		return pfLiveState{}, err
	}
	anchors, err := read("-sA")
	if err != nil {
		return pfLiveState{}, err
	}
	interfaces, err := read("-sI", "-v")
	if err != nil {
		return pfLiveState{}, err
	}
	return pfLiveState{Rules: translation + "\n" + filter, Anchors: anchors, Interfaces: interfaces}, nil
}

// CheckCompatible decides whether this Mac can host the isolation anchor.
//
// mainRules is the ruleset text to judge: pf.conf syntax and pfctl output both
// parse, as does the `-sI -v` skip marker. anchors names the anchors a
// main-ruleset load would have to preserve (liveOnlyAnchors). egressIfs are the
// interfaces traffic leaves through.
//
// It returns ErrIncompatible for a `set skip` on an egress interface (pf never
// evaluates that interface), a quick pass ahead of our anchor (the anchor never
// runs for that traffic), or, while a load is still needed, an anchor that load
// would destroy. Once attached no load happens, so no anchor is at risk.
func CheckCompatible(mainRules string, anchors []string, egressIfs []string) error {
	lines := pfLogicalLines(mainRules)
	for _, skip := range pfSkippedInterfaces(lines) {
		if pfSkipCovers(skip, egressIfs) {
			return ErrIncompatible{Reason: fmt.Sprintf("set skip covers %s, so pf would not filter that interface", skip)}
		}
	}
	if rule := pfBypassRule(lines); rule != "" {
		return ErrIncompatible{Reason: "a quick pass rule runs before the isolation anchor: " + rule}
	}
	if pfHookIn(lines) {
		return nil
	}
	for _, anchor := range anchors {
		if !pfAnchorSurvivesLoad(anchor) {
			return ErrIncompatible{Reason: fmt.Sprintf("attaching would destroy the anchor %s, which %s does not restore", anchor, pfConfPath)}
		}
	}
	return nil
}

// AttachOnce makes the main ruleset reference our anchor, after validating that
// it may. When the hook is already there it validates and loads nothing, so an
// attached Mac never has its main ruleset reloaded: that is what makes a second
// apply harmless to anchors a service inserted in the meantime.
func AttachOnce(r PFRunner) error {
	live, err := readPFLive(r)
	if err != nil {
		return err
	}
	egress, err := r.EgressInterfaces()
	if err != nil {
		return fmt.Errorf("find the egress interfaces: %w", err)
	}
	conf, err := r.ReadPFConf()
	if err != nil {
		return fmt.Errorf("read %s: %w", pfConfPath, err)
	}
	anchors := liveOnlyAnchors(append(parsePFAnchorList(live.Anchors), pfAnchorsIn(live.Rules)...), conf)
	if err := CheckCompatible(live.Rules+"\n"+live.Interfaces, anchors, egress); err != nil {
		return err
	}
	if pfHookIn(pfLogicalLines(live.Rules)) {
		return nil
	}
	// The load replaces the live main ruleset with this file. So the file must
	// pass the same checks, and must restore every rule that is live now.
	if err := CheckCompatible(conf, nil, egress); err != nil {
		return err
	}
	declared, _, err := r.Pfctl("", "-nvf", pfConfPath)
	if err != nil {
		return fmt.Errorf("parse %s: %w", pfConfPath, err)
	}
	if lost := liveRulesNotDeclared(live.Rules, declared); len(lost) > 0 {
		return ErrIncompatible{Reason: fmt.Sprintf("attaching would destroy a live rule %s does not restore: %s", pfConfPath, lost[0])}
	}
	if _, _, err := r.Pfctl(pfAttachText(conf), "-f", "-"); err != nil {
		return fmt.Errorf("load the pf main ruleset: %w", err)
	}
	present, err := ParentHookPresent(r)
	if err != nil {
		return fmt.Errorf("confirm the pf anchor hook: %w", err)
	}
	if !present {
		return errors.New("the pf main ruleset loaded, but the isolation anchor is not attached")
	}
	return nil
}

// pfAttachText is /etc/pf.conf with our anchor point inserted ahead of its first
// filter rule, so ahead of `anchor "com.apple/*"`. Apple's sub-anchors change at
// run time and are evaluated in order, so a quick pass in one of them would decide
// a packet before our drop ever ran. Going first, our quick rules decide every
// packet while isolated, and an empty anchor matches nothing, so the rest of the
// ruleset behaves as before. Translation and normalization rules come before any
// filter rule, so pf's required ordering holds. Lab leg L3 confirms pf accepts it.
func pfAttachText(conf string) string {
	var lines []string
	if trimmed := strings.TrimRight(conf, "\n"); trimmed != "" {
		lines = strings.Split(trimmed, "\n")
	}
	continued := false
	for n, raw := range lines {
		starts := !continued
		continued = strings.HasSuffix(strings.TrimRight(raw, " \t"), `\`)
		logical := pfLogicalLines(raw)
		if !starts || len(logical) == 0 {
			continue
		}
		switch strings.Fields(logical[0])[0] {
		case "anchor", "pass", "block", "antispoof":
			out := append(append(slices.Clone(lines[:n]), pfHookLine), lines[n:]...)
			return strings.Join(out, "\n") + "\n"
		}
	}
	return strings.Join(append(lines, pfHookLine), "\n") + "\n"
}

// ParentHookPresent reports whether the main ruleset references our anchor. Any
// later main-ruleset load by anyone else silently removes the reference, and an
// anchor nothing references enforces nothing.
func ParentHookPresent(r PFRunner) (bool, error) {
	stdout, _, err := r.Pfctl("", "-sr")
	if err != nil {
		return false, fmt.Errorf("read the pf main ruleset: %w", err)
	}
	return pfHookIn(pfLogicalLines(stdout)), nil
}

// pfLogicalLines strips comments outside quotes, joins continuations and drops
// blank lines.
func pfLogicalLines(text string) []string {
	text = strings.ReplaceAll(text, "\\\n", " ")
	var lines []string
	for _, raw := range strings.Split(text, "\n") {
		inQuote, end := false, len(raw)
		for i, c := range raw {
			if c == '"' {
				inQuote = !inQuote
			} else if c == '#' && !inQuote {
				end = i
				break
			}
		}
		if line := strings.TrimSpace(raw[:end]); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func pfHookIn(lines []string) bool {
	return slices.ContainsFunc(lines, pfLineIsHook)
}

// pfLineIsHook matches only an unqualified reference. `anchor "x" in on en0`
// evaluates the anchor for part of the traffic, which is not attached.
func pfLineIsHook(line string) bool {
	fields := strings.Fields(line)
	if len(fields) < 2 || fields[0] != "anchor" || strings.Trim(fields[1], `"`) != pfAnchorPath {
		return false
	}
	return len(fields) == 2 || (len(fields) == 3 && fields[2] == "all")
}

// pfBypassRule returns the first rule that lets traffic past our anchor: a
// filter rule that passes quick before the hook, or a translation rule that
// passes at all (`rdr pass` and friends skip the filter rules altogether, so
// their position relative to the hook is irrelevant).
func pfBypassRule(lines []string) string {
	hooked := false
	for _, line := range lines {
		fields := strings.Fields(pfWithoutQuotedText(line))
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "pass":
			if !hooked && slices.Contains(fields, "quick") {
				return line
			}
		case "nat", "rdr", "binat":
			if fields[1] == "pass" {
				return line
			}
		case "anchor":
			hooked = hooked || pfLineIsHook(line)
		}
	}
	return ""
}

// pfWithoutQuotedText blanks quoted strings so a label cannot look like syntax.
func pfWithoutQuotedText(line string) string {
	return pfQuotedText.ReplaceAllString(line, `""`)
}

var pfQuotedText = regexp.MustCompile(`"[^"]*"`)

var (
	pfSkipConfLine = regexp.MustCompile(`^set\s+skip\s+on\s+(.+)$`)
	pfSkipLiveLine = regexp.MustCompile(`^(\S+)\s+\(skip\)$`)
)

func pfSkippedInterfaces(lines []string) []string {
	var skipped []string
	for _, line := range lines {
		if m := pfSkipLiveLine.FindStringSubmatch(line); m != nil {
			skipped = append(skipped, m[1])
		}
		if m := pfSkipConfLine.FindStringSubmatch(line); m != nil {
			skipped = append(skipped, strings.FieldsFunc(m[1], func(c rune) bool {
				return c == '{' || c == '}' || c == ',' || c == ' ' || c == '\t'
			})...)
		}
	}
	return skipped
}

// pfSkipCovers: a `set skip` may name an interface or its driver group (`en`
// covers en0). With no known egress interface any non-loopback skip counts:
// nothing shows that it is safe.
func pfSkipCovers(skip string, egressIfs []string) bool {
	if len(egressIfs) == 0 {
		return strings.TrimRight(skip, "0123456789") != "lo"
	}
	return slices.ContainsFunc(egressIfs, func(egress string) bool {
		return skip == egress || skip == strings.TrimRight(egress, "0123456789")
	})
}

var pfAnchorKeywords = []string{"anchor", "nat-anchor", "rdr-anchor", "binat-anchor", "scrub-anchor", "dummynet-anchor"}

// pfAnchorsIn names every anchor a ruleset references or loads. A wildcard
// anchor point (`com.apple/*`) is reported by the path it covers.
func pfAnchorsIn(text string) []string {
	var names []string
	for _, line := range pfLogicalLines(text) {
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[0] == "load" && fields[1] == "anchor" {
			names = append(names, strings.Trim(fields[2], `"`))
		}
		if len(fields) >= 2 && slices.Contains(pfAnchorKeywords, fields[0]) {
			names = append(names, strings.TrimSuffix(strings.Trim(fields[1], `"`), "/*"))
		}
	}
	return uniqueSorted(names)
}

// parsePFAnchorList reads `pfctl -sA`: one anchor per line, indented.
func parsePFAnchorList(stdout string) []string {
	var names []string
	for _, line := range strings.Split(stdout, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			names = append(names, name)
		}
	}
	return names
}

// liveOnlyAnchors is what a main-ruleset load would lose: live anchors the file
// does not declare. Internet Sharing always counts, even if the file names it:
// the file could restore the anchor point but never the rules the service put
// in it.
func liveOnlyAnchors(live []string, conf string) []string {
	declared := pfAnchorsIn(conf)
	var lost []string
	for _, name := range uniqueSorted(live) {
		covered := slices.ContainsFunc(declared, func(d string) bool {
			return name == d || strings.HasPrefix(name, d+"/")
		})
		if name == pfInternetSharingAnchor || !covered {
			lost = append(lost, name)
		}
	}
	return lost
}

// pfAnchorSurvivesLoad: Apple's own anchors are loaded by the stock file, and
// our own are ours. The prefix test must keep the slash: pfInternetSharingAnchor
// starts with "com.apple" but is not one of them.
func pfAnchorSurvivesLoad(name string) bool {
	for _, owner := range []string{"com.apple", "com.breeze"} {
		if name == owner || strings.HasPrefix(name, owner+"/") {
			return true
		}
	}
	return false
}

// liveRulesNotDeclared lists live rules a load of pf.conf would destroy.
// declared is `pfctl -nvf`, which prints the file's rules as the kernel would.
// Anchors are left to CheckCompatible, and any mismatch in how pfctl prints a
// rule refuses: a refused apply is recoverable and a destroyed firewall is not.
func liveRulesNotDeclared(live, declared string) []string {
	normalise := func(line string) string {
		fields := strings.Fields(line)
		if len(fields) > 0 && strings.HasPrefix(fields[0], "@") {
			fields = fields[1:]
		}
		return strings.Join(fields, " ")
	}
	known := map[string]bool{}
	for _, line := range pfLogicalLines(declared) {
		known[normalise(line)] = true
	}
	var lost []string
	for _, line := range pfLogicalLines(live) {
		fields := strings.Fields(line)
		if len(fields) == 0 || slices.Contains(pfAnchorKeywords, fields[0]) {
			continue
		}
		if !known[normalise(line)] {
			lost = append(lost, strings.Join(fields, " "))
		}
	}
	return lost
}

func uniqueSorted(names []string) []string {
	out := slices.Clone(names)
	slices.Sort(out)
	return slices.Compact(out)
}
