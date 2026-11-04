package security

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Linux firewall probe (#10909).
//
// getFirewallStatusLinux asks ufw, then firewalld, then reads the kernel
// ruleset with nft and iptables. A host with none of those tools, or where the
// agent may not read the ruleset, has no firewall answer to give. That is a
// state of the host, so it is reported as unsupported with a reason instead of
// failing as a collection warning on every tick.
//
// This file has no build tag so the whole order is tested on every OS.

const (
	// FirewallUnsupportedNoTool: ufw, firewall-cmd, nft and iptables are all absent.
	FirewallUnsupportedNoTool = "no_firewall_tool"
	// FirewallUnsupportedPermission: nft or iptables exists but refused to read
	// the ruleset (agent not root, or a container without CAP_NET_ADMIN).
	FirewallUnsupportedPermission = "permission"
)

// FirewallUnsupportedError reports that this host cannot answer the firewall
// question. It wraps ErrNotSupported, so CollectStatus does not report it as a
// collection failure.
type FirewallUnsupportedError struct {
	Reason string
}

func (e *FirewallUnsupportedError) Error() string {
	return "firewall status is not available on this host: " + e.Reason
}

func (e *FirewallUnsupportedError) Unwrap() error { return ErrNotSupported }

// applyFirewallPosture records the firewall read on status and returns the
// error CollectStatus should report, if any. FirewallEnabled stays nil for
// anything but a real reading.
func applyFirewallPosture(status *SecurityStatus, enabled bool, err error) error {
	status.FirewallEnabled = firewallState(enabled, err)
	switch {
	case err == nil && enabled:
		status.FirewallStatus = "enabled"
	case err == nil:
		status.FirewallStatus = "disabled"
	case errors.Is(err, ErrNotSupported):
		status.FirewallStatus = "unsupported"
		var unsupported *FirewallUnsupportedError
		if errors.As(err, &unsupported) {
			status.FirewallStatusReason = unsupported.Reason
		}
	default:
		return err
	}
	return nil
}

// firewallToolRecheck is how long a tool's availability is trusted. An hour
// keeps the tick free of repeated checks and still picks up a firewall
// installed later, or a permission that changed.
const firewallToolRecheck = time.Hour

const (
	firewallStateProbeTimeout = 5 * time.Second
	// Reading a whole ruleset takes longer than asking a daemon for one word,
	// most of all on hosts with large generated rulesets.
	firewallRulesetProbeTimeout = 10 * time.Second
)

// firewallToolDirs covers an agent started with a PATH that has no sbin, where
// nft and iptables usually live.
var firewallToolDirs = []string{"/usr/sbin", "/sbin", "/usr/bin", "/bin"}

// linuxFirewallExec and linuxFirewallRulesetExec are the only spawn paths for
// this probe, so tests can fake every tool's output and count spawns.
var (
	linuxFirewallExec        = firewallStatusFromCommand
	linuxFirewallRulesetExec = firewallRulesetFromCommand
)

// firewallRulesetFromCommand runs a ruleset read with stdout and stderr apart.
// On a table managed by iptables-nft, nft writes a "# Warning" to stderr while
// it prints the ruleset. In one merged stream that text lands in the middle of
// rule lines and could split a verdict in two.
func firewallRulesetFromCommand(timeout time.Duration, name string, args ...string) (stdout, stderr string, zeroExit bool, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var out, errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return "", "", false, false
	}
	if err != nil && out.Len() == 0 && errOut.Len() == 0 {
		// The spawn itself failed, so the error is the only text there is.
		errOut.WriteString(err.Error())
	}
	return out.String(), errOut.String(), err == nil, true
}

var linuxFirewallTools = newFirewallToolAvailability()

type firewallToolState struct {
	path      string
	present   bool
	denied    bool
	checkedAt time.Time
}

// firewallToolAvailability holds one cached availability answer per tool.
type firewallToolAvailability struct {
	now      func() time.Time
	lookPath func(name string) (string, bool)

	mu                sync.Mutex
	tools             map[string]firewallToolState
	unsupportedReason string
	unsupportedLogged time.Time
}

func newFirewallToolAvailability() *firewallToolAvailability {
	return &firewallToolAvailability{
		now:      time.Now,
		lookPath: func(name string) (string, bool) { return lookPathOrDirs(name, firewallToolDirs) },
		tools:    map[string]firewallToolState{},
	}
}

func lookPathOrDirs(name string, dirs []string) (string, bool) {
	if path, err := exec.LookPath(name); err == nil {
		return path, true
	}
	for _, dir := range dirs {
		path := filepath.Join(dir, name)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return path, true
		}
	}
	return "", false
}

// lookup returns the cached answer for tool, checking again once it has aged out.
func (a *firewallToolAvailability) lookup(tool string) firewallToolState {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	state, ok := a.tools[tool]
	if !ok || now.Sub(state.checkedAt) >= firewallToolRecheck {
		path, present := a.lookPath(tool)
		state = firewallToolState{path: path, present: present, checkedAt: now}
		a.tools[tool] = state
	}
	return state
}

// markDenied stops spawning tool until its cached answer ages out.
func (a *firewallToolAvailability) markDenied(tool string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	state := a.tools[tool]
	state.denied = true
	a.tools[tool] = state
}

func (a *firewallToolAvailability) invalidate() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tools = map[string]firewallToolState{}
}

// noteUnsupported logs an unsupported result at DEBUG, once per recheck window
// or when the reason changes. It reports whether it logged.
func (a *firewallToolAvailability) noteUnsupported(reason string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	if reason == a.unsupportedReason && now.Sub(a.unsupportedLogged) < firewallToolRecheck {
		return false
	}
	a.unsupportedReason = reason
	a.unsupportedLogged = now
	log.Debug("firewall status is not available on this host",
		"reason", reason, "recheckIn", firewallToolRecheck.String())
	return true
}

func (a *firewallToolAvailability) noteSupported() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.unsupportedReason = ""
}

func getFirewallStatusLinux() (bool, error) {
	tools := linuxFirewallTools
	enabled, err := probeLinuxFirewall(tools)
	var unsupported *FirewallUnsupportedError
	switch {
	case err == nil:
		tools.noteSupported()
	case errors.As(err, &unsupported):
		tools.noteUnsupported(unsupported.Reason)
	}
	return enabled, err
}

func probeLinuxFirewall(tools *firewallToolAvailability) (bool, error) {
	anyTool := false

	if ufw := tools.lookup("ufw"); ufw.present {
		anyTool = true
		if stdout, zeroExit, ok := linuxFirewallExec(firewallStateProbeTimeout, ufw.path, "status"); ok && zeroExit {
			if enabled, known := interpretFirewallState("ufw", stdout); known {
				return enabled, nil
			}
		}
	}

	// firewall-cmd / systemctl probe a different daemon (firewalld) than ufw.
	// On a host where ufw is the ACTIVE firewall but firewalld is installed
	// + masked (a common Ubuntu/Debian shape), `firewall-cmd --state` exits
	// non-zero and prints "not running" or a D-Bus failure on stdout. The
	// previous version trusted that text regardless of exit code, which
	// silently reported the host as firewall=disabled — strictly worse than
	// the WARN it replaced because FirewallEnabled feeds security posture
	// (status.go's posture computation). We now only trust a recognized state
	// when the tool ALSO exited 0; non-zero exit → unknown → fall through.
	firewalldInactive := false
	if firewallCmd := tools.lookup("firewall-cmd"); firewallCmd.present {
		anyTool = true
		if stdout, zeroExit, ok := linuxFirewallExec(firewallStateProbeTimeout, firewallCmd.path, "--state"); ok && zeroExit {
			if enabled, known := interpretFirewallState("firewall-cmd", stdout); known {
				return enabled, nil
			}
		}

		// Only asked when firewalld is installed: `is-active` prints "inactive"
		// for a unit that does not exist. It exits 3 for inactive and failed,
		// which interpretFirewallState's exact match still recognizes. Inactive
		// firewalld does not mean no firewall, so the ruleset is read first.
		if systemctl := tools.lookup("systemctl"); systemctl.present {
			if stdout, zeroExit, ok := linuxFirewallExec(firewallStateProbeTimeout, systemctl.path, "is-active", "firewalld"); ok {
				enabled, known := interpretFirewallState("systemctl", stdout)
				switch {
				case known && enabled && zeroExit:
					return true, nil
				case known && !enabled:
					firewalldInactive = true
				}
			}
		}
	}

	nftOutput, nftRead := readFirewallRuleset(tools, "nft", "list", "ruleset")
	if nftRead == rulesetAnswered {
		return nftRulesetFiltersInput(nftOutput), nil
	}
	iptablesOutput, iptablesRead := readFirewallRuleset(tools, "iptables", "-S", "INPUT")
	if iptablesRead == rulesetAnswered {
		return iptablesFiltersInput(iptablesOutput), nil
	}
	if nftRead != rulesetAbsent || iptablesRead != rulesetAbsent {
		anyTool = true
	}

	switch {
	case nftRead == rulesetFailed:
		return false, fmt.Errorf("unable to determine firewall status: nft: %s", truncateForLog(nftOutput, 200))
	case iptablesRead == rulesetFailed:
		return false, fmt.Errorf("unable to determine firewall status: iptables: %s", truncateForLog(iptablesOutput, 200))
	case nftRead == rulesetDenied || iptablesRead == rulesetDenied:
		// Checked before the two "disabled" answers below: with a ruleset we
		// could not read, neither of them is known to be true.
		return false, &FirewallUnsupportedError{Reason: FirewallUnsupportedPermission}
	case iptablesRead == rulesetNoFilterTable || firewalldInactive:
		return false, nil
	case !anyTool:
		return false, &FirewallUnsupportedError{Reason: FirewallUnsupportedNoTool}
	}
	return false, errors.New("unable to determine firewall status")
}

type rulesetRead int

const (
	rulesetAbsent rulesetRead = iota
	rulesetAnswered
	rulesetDenied
	rulesetFailed
	// rulesetNoFilterTable: iptables-legacy has no filter table loaded, so it
	// holds no INPUT rules.
	rulesetNoFilterTable
)

func readFirewallRuleset(tools *firewallToolAvailability, tool string, args ...string) (string, rulesetRead) {
	state := tools.lookup(tool)
	switch {
	case !state.present:
		return "", rulesetAbsent
	case state.denied:
		return "", rulesetDenied
	}

	stdout, stderr, zeroExit, ok := linuxFirewallRulesetExec(firewallRulesetProbeTimeout, state.path, args...)
	if !ok {
		return "timed out", rulesetFailed
	}
	if zeroExit {
		return stdout, rulesetAnswered
	}
	output := strings.TrimSpace(stderr + "\n" + stdout)
	lower := strings.ToLower(output)
	switch {
	case strings.Contains(lower, "permission denied"),
		strings.Contains(lower, "operation not permitted"),
		strings.Contains(lower, "you must be root"):
		tools.markDenied(tool)
		return output, rulesetDenied
	case strings.Contains(lower, "table does not exist"):
		return output, rulesetNoFilterTable
	}
	return output, rulesetFailed
}

// firewallFields splits one line of tool output into tokens. Quoted text stays
// a single token that keeps its quotes, so a comment or log prefix can never
// read as a verdict. separators are split on outside quotes as well as space.
func firewallFields(line, separators string) []string {
	var b strings.Builder
	inQuote := false
	for _, r := range line {
		switch {
		case r == '"':
			inQuote = !inQuote
			b.WriteRune(r)
		case inQuote && (r == ' ' || r == '\t'):
			b.WriteRune('_')
		case inQuote:
			b.WriteRune(r)
		case strings.ContainsRune(separators, r):
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	return strings.Fields(b.String())
}

type nftChain struct {
	inputHook bool
	drops     bool
	next      []string
}

// nftRulesetFiltersInput reports whether `nft list ruleset` drops or rejects
// anything on input: a filter chain on the input hook (ip, ip6 or inet) whose
// policy is drop, or with a drop or reject verdict in it or in a chain it jumps
// to. An empty or accept-only ruleset is false.
func nftRulesetFiltersInput(ruleset string) bool {
	tables := map[string]map[string]*nftChain{}
	var table string
	var chain *nftChain
	depth := 0

	for _, line := range strings.Split(ruleset, "\n") {
		line = stripNftComment(line)
		fields := firewallFields(line, "{},;:")
		switch {
		case len(fields) == 0:
		case depth == 0 && fields[0] == "table" && len(fields) >= 3:
			table = fields[1] + " " + fields[2]
			tables[table] = map[string]*nftChain{}
		case depth == 1 && fields[0] == "chain" && len(fields) >= 2 && tables[table] != nil:
			chain = &nftChain{}
			tables[table][fields[1]] = chain
		case chain != nil:
			readNftChainLine(chain, fields)
		}
		depth += nftBraceDelta(line)
		if depth <= 1 {
			chain = nil
		}
	}

	for name, chains := range tables {
		family, _, _ := strings.Cut(name, " ")
		if family != "ip" && family != "ip6" && family != "inet" {
			continue
		}
		for _, start := range chains {
			if start.inputHook && nftChainDrops(chains, start, map[*nftChain]bool{}) {
				return true
			}
		}
	}
	return false
}

func readNftChainLine(chain *nftChain, fields []string) {
	for i, field := range fields {
		switch field {
		case "drop", "reject":
			chain.drops = true
		case "jump", "goto":
			if i+1 < len(fields) {
				chain.next = append(chain.next, fields[i+1])
			}
		case "type":
			if i+3 < len(fields) && fields[i+1] == "filter" && fields[i+2] == "hook" && fields[i+3] == "input" {
				chain.inputHook = true
			}
		}
	}
}

func nftChainDrops(chains map[string]*nftChain, chain *nftChain, seen map[*nftChain]bool) bool {
	if chain == nil || seen[chain] {
		return false
	}
	seen[chain] = true
	if chain.drops {
		return true
	}
	for _, name := range chain.next {
		if nftChainDrops(chains, chains[name], seen) {
			return true
		}
	}
	return false
}

// stripNftComment removes a "#" comment that starts outside quoted text.
func stripNftComment(line string) string {
	inQuote := false
	for i, r := range line {
		switch {
		case r == '"':
			inQuote = !inQuote
		case r == '#' && !inQuote:
			return line[:i]
		}
	}
	return line
}

// nftBraceDelta counts braces outside quoted text.
func nftBraceDelta(line string) int {
	delta := 0
	inQuote := false
	for _, r := range line {
		switch {
		case r == '"':
			inQuote = !inQuote
		case inQuote:
		case r == '{':
			delta++
		case r == '}':
			delta--
		}
	}
	return delta
}

// iptablesFiltersInput reports whether `iptables -S INPUT` shows a DROP or
// REJECT policy or rule. It sees only the INPUT chain: a drop reached through a
// jump to a user chain is not visible here and reads as false. The output is
// the same for iptables-legacy and iptables-nft, which may add a "# Warning"
// line.
func iptablesFiltersInput(output string) bool {
	for _, line := range strings.Split(output, "\n") {
		fields := firewallFields(line, "")
		if len(fields) < 3 || fields[1] != "INPUT" {
			continue
		}
		switch fields[0] {
		case "-P":
			if isIptablesDropTarget(fields[2]) {
				return true
			}
		case "-A":
			for i := 2; i+1 < len(fields); i++ {
				if fields[i] == "-j" && isIptablesDropTarget(fields[i+1]) {
					return true
				}
			}
		}
	}
	return false
}

func isIptablesDropTarget(target string) bool {
	return target == "DROP" || target == "REJECT"
}
