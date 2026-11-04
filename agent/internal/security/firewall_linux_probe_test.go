package security

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Linux firewall probe (#10909). Every case runs against fakes, so the whole
// order (ufw, firewalld, nft, iptables) is tested on every OS.

type fakeFwOut struct {
	out     string
	stderr  string
	zero    bool
	timeout bool
}

type fakeLinuxFirewall struct {
	present map[string]bool
	outs    map[string]fakeFwOut
	calls   []string
	lookups int
	now     time.Time
}

// Not parallel: swaps package-level seams.
func stubLinuxFirewall(t *testing.T, present []string, outs map[string]fakeFwOut) *fakeLinuxFirewall {
	t.Helper()
	f := &fakeLinuxFirewall{present: map[string]bool{}, outs: outs, now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)}
	for _, tool := range present {
		f.present[tool] = true
	}
	origExec, origRuleset, origTools := linuxFirewallExec, linuxFirewallRulesetExec, linuxFirewallTools
	spawn := func(name string, args []string) fakeFwOut {
		tool := filepath.Base(name)
		call := strings.Join(append([]string{tool}, args...), " ")
		f.calls = append(f.calls, call)
		// A key naming the whole call ("iptables -S") wins over the tool name.
		out, ok := f.outs[call]
		if !ok {
			out, ok = f.outs[tool]
		}
		if !ok {
			t.Fatalf("unexpected spawn of %s", tool)
		}
		return out
	}
	linuxFirewallExec = func(_ time.Duration, name string, args ...string) (string, bool, bool) {
		out := spawn(name, args)
		if out.timeout {
			return "", false, false
		}
		return out.out, out.zero, true
	}
	// Failing tools report on stderr, as the real ones do.
	linuxFirewallRulesetExec = func(_ time.Duration, name string, args ...string) (string, string, bool, bool) {
		out := spawn(name, args)
		switch {
		case out.timeout:
			return "", "", false, false
		case out.zero:
			return out.out, out.stderr, true, true
		}
		return "", out.out, false, true
	}
	tools := newFirewallToolAvailability()
	tools.now = func() time.Time { return f.now }
	tools.lookPath = func(name string) (string, bool) {
		f.lookups++
		if f.present[name] {
			return "/usr/sbin/" + name, true
		}
		return "", false
	}
	linuxFirewallTools = tools
	t.Cleanup(func() {
		linuxFirewallExec, linuxFirewallRulesetExec, linuxFirewallTools = origExec, origRuleset, origTools
	})
	return f
}

const (
	nftInputDrop = `table inet filter {
	chain input {
		type filter hook input priority filter; policy drop;
		ct state established,related accept
		iif "lo" accept
		tcp dport 22 accept
	}
	chain forward {
		type filter hook forward priority filter; policy drop;
	}
	chain output {
		type filter hook output priority filter; policy accept;
	}
}`
	nftAcceptPolicyDropRule = `table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
		ct state invalid drop
		tcp dport 22 accept
	}
}`
	nftAcceptPolicyRejectRule = `table inet firewalld {
	chain filter_INPUT {
		type filter hook input priority filter + 10; policy accept;
		ct state { established, related } accept
		iifname "lo" accept
		reject with icmpx admin-prohibited
	}
}`
	nftAcceptOnly = `table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
		tcp dport 22 accept
	}
}`
	nftOutputDropOnly = `table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
	}
	chain output {
		type filter hook output priority filter; policy drop;
		oifname "eth0" drop
	}
	chain forward {
		type filter hook forward priority filter; policy accept;
		ct state invalid drop
	}
}`
	nftJumpToDrop = `table ip filter {
	chain INPUT {
		type filter hook input priority filter; policy accept;
		counter packets 10 bytes 600 jump custom-input
	}
	chain custom-input {
		tcp dport 23 counter packets 0 bytes 0 drop
	}
	chain unreachable {
		drop
	}
}`
	nftDropOnlyInComment = `table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
		tcp dport 22 accept comment "drop everything else later"
		log prefix "DROP: " accept
	}
}`
	nftNamedSetMultiline = `table inet filter {
	set blocklist {
		type ipv4_addr
		elements = { 192.0.2.1, 192.0.2.2,
			     192.0.2.3 }
	}
	chain input {
		type filter hook input priority filter; policy accept;
		ip saddr @blocklist accept
	}
	chain output {
		type filter hook output priority filter; policy accept;
		ip daddr @blocklist drop
	}
}`
	nftUnreachableDropOnly = `table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
	}
	chain helper {
		drop
	}
}`
	// Captured from nft 1.0.6 on tables written by iptables-nft: the rule text
	// has no xt comment and doubled spaces.
	nftIptablesManagedJump = `table ip filter {
	chain CUSTOM {
		tcp dport 23  counter packets 0 bytes 0 drop
	}

	chain INPUT {
		type filter hook input priority filter; policy accept;
		ct state established counter packets 0 bytes 0 accept
		 counter packets 0 bytes 0 accept
		counter packets 0 bytes 0 jump CUSTOM
	}

	chain FORWARD {
		type filter hook forward priority filter; policy accept;
		counter packets 0 bytes 0 reject
	}
}`
	// The same host with the jump removed, as one merged stream: the stderr
	// warning landed inside a rule line.
	nftIptablesManagedSpliced = `table ip filter {
	chain CUSTOM {
		tcp dport 23  counter packets 0 bytes 0 drop
	}

	chain INPUT {
		type filter hook input priority filter; policy accept;
		ct state established counter packets 0 bytes 0 # Warning: table ip filter is managed by iptables-nft, do not touch!
accept
		 counter packets 0 bytes 0 accept
	}

	chain FORWARD {
		type filter hook forward priority filter; policy accept;
		counter packets 0 bytes 0 reject
	}
}`
	nftManagedWarning  = "# Warning: table ip filter is managed by iptables-nft, do not touch!\n"
	nftTrailingComment = `table inet filter {
	chain input {
		type filter hook input priority filter; policy accept;
		tcp dport 22 accept # drop { everything
	}
	chain output {
		type filter hook output priority filter; policy drop;
	}
}`
	nftVmapDrop = `table ip filter {
	chain INPUT {
		type filter hook input priority filter; policy accept;
		tcp dport vmap { 22 : accept, 23 : drop }
	}
}`
	nftArpInputDrop = `table arp filter {
	chain input {
		type filter hook input priority filter; policy drop;
	}
}`
	nftNatInputDrop = `table ip nat {
	chain input {
		type nat hook input priority 100; policy accept;
		tcp dport 23 drop
	}
}
table ip filter {
	chain prerouting {
		type filter hook prerouting priority raw; policy accept;
		drop
	}
}`

	// `iptables -S INPUT` prints only the INPUT policy and INPUT rules.
	iptablesLegacyDropPolicy = `-P INPUT DROP
-A INPUT -i lo -j ACCEPT
-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT`
	iptablesLegacyRejectRule = `-P INPUT ACCEPT
-A INPUT -i lo -j ACCEPT
-A INPUT -j REJECT --reject-with icmp-host-prohibited`
	iptablesNftBackedDropRule = `# Warning: iptables-legacy tables present, use iptables-legacy to see them
-P INPUT ACCEPT
-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p tcp -m tcp --dport 23 -j DROP`
	iptablesNftBackedAcceptOnly = `# Warning: iptables-legacy tables present, use iptables-legacy to see them
-P INPUT ACCEPT
-A INPUT -i lo -j ACCEPT`
	iptablesAcceptOnly = `-P INPUT ACCEPT
-A INPUT -i lo -j ACCEPT`
	iptablesPolicyOnly = `-P INPUT ACCEPT`
	iptablesUserChain  = `-P INPUT ACCEPT
-A INPUT -j f2b-sshd`
	// Captured from iptables-legacy 1.8.9 with a fail2ban-style chain: the
	// drop is only in a chain INPUT jumps to.
	iptablesJumpInput = `-P INPUT ACCEPT
-A INPUT -p tcp -m tcp --dport 22 -j f2b-sshd
-A INPUT -j ACCEPTONLY
-A INPUT -j LOG`
	iptablesJumpFull = `-P INPUT ACCEPT
-P FORWARD ACCEPT
-P OUTPUT ACCEPT
-N ACCEPTONLY
-N f2b-sshd
-A INPUT -p tcp -m tcp --dport 22 -j f2b-sshd
-A INPUT -j ACCEPTONLY
-A INPUT -j LOG
-A FORWARD -j DROP
-A ACCEPTONLY -j ACCEPT
-A f2b-sshd -s 203.0.113.9/32 -j REJECT --reject-with icmp-port-unreachable
-A f2b-sshd -j RETURN`
	// The same host with no REJECT in the jumped-to chains; FORWARD still drops.
	iptablesJumpFullAcceptOnly = `-P INPUT ACCEPT
-P FORWARD DROP
-P OUTPUT ACCEPT
-N ACCEPTONLY
-N f2b-sshd
-A INPUT -p tcp -m tcp --dport 22 -j f2b-sshd
-A INPUT -j ACCEPTONLY
-A INPUT -j LOG
-A FORWARD -j DROP
-A ACCEPTONLY -j ACCEPT
-A f2b-sshd -j RETURN`
	iptablesJumpCycle = `-P INPUT ACCEPT
-N A
-N B
-A INPUT -j A
-A A -j B
-A B -g A`
	iptablesDropInComment = `-P INPUT ACCEPT
-A INPUT -p tcp -m tcp --dport 22 -m comment --comment "then -j DROP the rest" -j ACCEPT`

	// Captured from nftables and iptables 1.8.9, run non-root and as root
	// without CAP_NET_ADMIN.
	nftPermissionDenied            = "Operation not permitted (you must be root)\nnetlink: Error: cache initialization failed: Operation not permitted"
	iptablesPermissionDenied       = "iptables v1.8.9 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)"
	iptablesLegacyPermissionDenied = "iptables v1.8.9 (legacy): can't initialize iptables table `filter': Permission denied (you must be root)\nPerhaps iptables or your kernel needs to be upgraded."
	iptablesLegacyNoTable          = "iptables v1.8.4 (legacy): can't initialize iptables table `filter': Table does not exist (do you need to insmod?)\nPerhaps iptables or your kernel needs to be upgraded."
)

func TestGetFirewallStatusLinux(t *testing.T) {
	type want struct {
		enabled     bool
		errNil      bool
		unsupported string // reason, when the result must be unsupported
	}
	enabled := want{enabled: true, errNil: true}
	disabled := want{enabled: false, errNil: true}
	unknown := want{}

	cases := []struct {
		name      string
		present   []string
		outs      map[string]fakeFwOut
		want      want
		wantCalls []string
	}{
		{
			name:      "ufw active",
			present:   []string{"ufw", "nft", "iptables"},
			outs:      map[string]fakeFwOut{"ufw": {out: "Status: active", zero: true}},
			want:      enabled,
			wantCalls: []string{"ufw status"},
		},
		{
			name:      "ufw inactive",
			present:   []string{"ufw"},
			outs:      map[string]fakeFwOut{"ufw": {out: "Status: inactive", zero: true}},
			want:      disabled,
			wantCalls: []string{"ufw status"},
		},
		{
			name:      "firewalld running",
			present:   []string{"firewall-cmd", "systemctl", "nft"},
			outs:      map[string]fakeFwOut{"firewall-cmd": {out: "running", zero: true}},
			want:      enabled,
			wantCalls: []string{"firewall-cmd --state"},
		},
		{
			name:    "firewalld installed but inactive (systemctl exit 3), no nft or iptables",
			present: []string{"firewall-cmd", "systemctl"},
			outs: map[string]fakeFwOut{
				"firewall-cmd": {out: "not running", zero: false},
				"systemctl":    {out: "inactive", zero: false},
			},
			want:      disabled,
			wantCalls: []string{"firewall-cmd --state", "systemctl is-active firewalld"},
		},
		{
			name:    "firewalld inactive but the nft ruleset drops: the kernel wins",
			present: []string{"firewall-cmd", "systemctl", "nft"},
			outs: map[string]fakeFwOut{
				"firewall-cmd": {out: "not running", zero: false},
				"systemctl":    {out: "inactive", zero: false},
				"nft":          {out: nftInputDrop, zero: true},
			},
			want:      enabled,
			wantCalls: []string{"firewall-cmd --state", "systemctl is-active firewalld", "nft list ruleset"},
		},
		{
			name:    "firewalld active via systemctl",
			present: []string{"firewall-cmd", "systemctl", "nft"},
			outs: map[string]fakeFwOut{
				"firewall-cmd": {out: "Failed to connect to bus: No such file or directory", zero: false},
				"systemctl":    {out: "active", zero: true},
			},
			want:      enabled,
			wantCalls: []string{"firewall-cmd --state", "systemctl is-active firewalld"},
		},
		{
			name:      "systemctl alone is not a firewall tool and is not spawned",
			present:   []string{"systemctl"},
			outs:      map[string]fakeFwOut{},
			want:      want{unsupported: FirewallUnsupportedNoTool},
			wantCalls: nil,
		},
		{
			name:      "ufw needs root, nft answers",
			present:   []string{"ufw", "nft"},
			outs:      map[string]fakeFwOut{"ufw": {out: "ERROR: You need to be root to run this script", zero: false}, "nft": {out: nftAcceptOnly, zero: true}},
			want:      disabled,
			wantCalls: []string{"ufw status", "nft list ruleset"},
		},
		{name: "nft input policy drop", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftInputDrop, zero: true}}, want: enabled, wantCalls: []string{"nft list ruleset"}},
		{name: "nft policy accept with explicit drop rule", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftAcceptPolicyDropRule, zero: true}}, want: enabled},
		{name: "nft policy accept with reject rule", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftAcceptPolicyRejectRule, zero: true}}, want: enabled},
		{name: "nft accept only", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftAcceptOnly, zero: true}}, want: disabled},
		{name: "nft empty ruleset", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: "", zero: true}}, want: disabled, wantCalls: []string{"nft list ruleset"}},
		{
			// iptables-legacy rules are not in `nft list ruleset`, which prints
			// nothing on a legacy-only host (captured in the lab).
			name:      "nft empty, iptables-legacy drops",
			present:   []string{"nft", "iptables"},
			outs:      map[string]fakeFwOut{"nft": {out: "", zero: true}, "iptables": {out: iptablesLegacyDropPolicy, zero: true}},
			want:      enabled,
			wantCalls: []string{"nft list ruleset", "iptables -S INPUT"},
		},
		{name: "nft accept only, iptables-legacy drops", present: []string{"nft", "iptables"}, outs: map[string]fakeFwOut{"nft": {out: nftAcceptOnly, zero: true}, "iptables": {out: iptablesLegacyRejectRule, zero: true}}, want: enabled},
		{name: "nft empty, iptables accept only", present: []string{"nft", "iptables"}, outs: map[string]fakeFwOut{"nft": {out: "", zero: true}, "iptables": {out: iptablesAcceptOnly, zero: true}}, want: disabled},
		{
			name:    "nft answers, iptables-nft refuses a native nft table",
			present: []string{"nft", "iptables"},
			outs: map[string]fakeFwOut{
				"nft":      {out: nftAcceptOnly, zero: true},
				"iptables": {out: "iptables v1.8.9 (nf_tables): table `filter' is incompatible, use 'nft' tool.", zero: false},
			},
			want: disabled,
		},
		{name: "nft answers, iptables not permitted", present: []string{"nft", "iptables"}, outs: map[string]fakeFwOut{"nft": {out: nftAcceptOnly, zero: true}, "iptables": {out: iptablesPermissionDenied, zero: false}}, want: disabled},
		{
			name:    "nft timed out, iptables accept only is unknown",
			present: []string{"nft", "iptables"},
			outs:    map[string]fakeFwOut{"nft": {timeout: true}, "iptables": {out: iptablesAcceptOnly, zero: true}},
			want:    unknown,
		},
		{
			name:    "nft failed, iptables accept only is unknown",
			present: []string{"nft", "iptables"},
			outs:    map[string]fakeFwOut{"nft": {out: "Error: Could not process rule: Protocol not supported", zero: false}, "iptables": {out: iptablesAcceptOnly, zero: true}},
			want:    unknown,
		},
		{
			name:    "nft not permitted, iptables accept only is not disabled",
			present: []string{"nft", "iptables"},
			outs:    map[string]fakeFwOut{"nft": {out: nftPermissionDenied, zero: false}, "iptables": {out: iptablesAcceptOnly, zero: true}},
			want:    want{unsupported: FirewallUnsupportedPermission},
		},
		{
			name:      "firewalld inactive, nft empty: disabled from the ruleset",
			present:   []string{"firewall-cmd", "systemctl", "nft"},
			outs:      map[string]fakeFwOut{"firewall-cmd": {out: "not running", zero: false}, "systemctl": {out: "inactive", zero: false}, "nft": {out: "", zero: true}},
			want:      disabled,
			wantCalls: []string{"firewall-cmd --state", "systemctl is-active firewalld", "nft list ruleset"},
		},
		{name: "nft drops only on output and forward", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftOutputDropOnly, zero: true}}, want: disabled},
		{name: "nft input jumps to a chain that drops", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftJumpToDrop, zero: true}}, want: enabled},
		{name: "nft drop in an unreachable chain only", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftUnreachableDropOnly, zero: true}}, want: disabled},
		{name: "nft drop only inside quoted text", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftDropOnlyInComment, zero: true}}, want: disabled},
		{name: "nft multi-line named set", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftNamedSetMultiline, zero: true}}, want: disabled},
		{name: "nft iptables-managed table, input jumps to a drop chain", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftIptablesManagedJump, stderr: nftManagedWarning, zero: true}}, want: enabled},
		{name: "nft iptables-managed table, drop chain no longer reached", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftIptablesManagedSpliced, zero: true}}, want: disabled},
		{name: "nft stderr is never parsed as ruleset", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftAcceptOnly, stderr: nftManagedWarning + nftInputDrop, zero: true}}, want: disabled},
		{name: "nft trailing comment", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftTrailingComment, zero: true}}, want: disabled},
		{name: "nft vmap drop verdict", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftVmapDrop, zero: true}}, want: enabled},
		{name: "nft arp family input hook does not count", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftArpInputDrop, zero: true}}, want: disabled},
		{name: "nft nat input hook and prerouting drop do not count", present: []string{"nft"}, outs: map[string]fakeFwOut{"nft": {out: nftNatInputDrop, zero: true}}, want: disabled},
		{
			name:      "iptables-legacy policy DROP",
			present:   []string{"iptables"},
			outs:      map[string]fakeFwOut{"iptables": {out: iptablesLegacyDropPolicy, zero: true}},
			want:      enabled,
			wantCalls: []string{"iptables -S INPUT"},
		},
		{name: "iptables-legacy REJECT rule", present: []string{"iptables"}, outs: map[string]fakeFwOut{"iptables": {out: iptablesLegacyRejectRule, zero: true}}, want: enabled},
		{name: "iptables nft-backed with warning line and DROP rule", present: []string{"iptables"}, outs: map[string]fakeFwOut{"iptables": {out: iptablesNftBackedDropRule, zero: true}}, want: enabled},
		{name: "iptables nft-backed with warning line, accept only", present: []string{"iptables"}, outs: map[string]fakeFwOut{"iptables": {out: iptablesNftBackedAcceptOnly, zero: true}}, want: disabled},
		{name: "iptables policy ACCEPT, accept rules only", present: []string{"iptables"}, outs: map[string]fakeFwOut{"iptables": {out: iptablesAcceptOnly, zero: true}}, want: disabled},
		{name: "iptables policy ACCEPT, no rules", present: []string{"iptables"}, outs: map[string]fakeFwOut{"iptables": {out: iptablesPolicyOnly, zero: true}}, want: disabled},
		{
			name:      "iptables INPUT jumps to a chain that rejects",
			present:   []string{"iptables"},
			outs:      map[string]fakeFwOut{"iptables -S INPUT": {out: iptablesJumpInput, zero: true}, "iptables -S": {out: iptablesJumpFull, zero: true}},
			want:      enabled,
			wantCalls: []string{"iptables -S INPUT", "iptables -S"},
		},
		{
			name:    "iptables jumped-to chains accept, FORWARD drops",
			present: []string{"iptables"},
			outs:    map[string]fakeFwOut{"iptables -S INPUT": {out: iptablesJumpInput, zero: true}, "iptables -S": {out: iptablesJumpFullAcceptOnly, zero: true}},
			want:    disabled,
		},
		{
			name:    "iptables INPUT goto a chain that drops",
			present: []string{"iptables"},
			outs:    map[string]fakeFwOut{"iptables -S INPUT": {out: "-P INPUT ACCEPT\n-A INPUT -g IN_zone", zero: true}, "iptables -S": {out: "-P INPUT ACCEPT\n-N IN_zone\n-A INPUT -g IN_zone\n-A IN_zone -j DROP", zero: true}},
			want:    enabled,
		},
		{
			name:    "iptables jump cycle terminates",
			present: []string{"iptables"},
			outs:    map[string]fakeFwOut{"iptables -S INPUT": {out: "-P INPUT ACCEPT\n-A INPUT -j A", zero: true}, "iptables -S": {out: iptablesJumpCycle, zero: true}},
			want:    disabled,
		},
		{
			name:    "iptables full listing fails after a jump: unknown",
			present: []string{"iptables"},
			outs:    map[string]fakeFwOut{"iptables -S INPUT": {out: iptablesUserChain, zero: true}, "iptables -S": {out: "iptables: unexpected failure", zero: false}},
			want:    unknown,
		},
		{
			name:      "iptables INPUT with no jumps needs one spawn",
			present:   []string{"iptables"},
			outs:      map[string]fakeFwOut{"iptables -S INPUT": {out: iptablesAcceptOnly, zero: true}},
			want:      disabled,
			wantCalls: []string{"iptables -S INPUT"},
		},
		{
			name:      "iptables INPUT drops itself: no full listing",
			present:   []string{"iptables"},
			outs:      map[string]fakeFwOut{"iptables -S INPUT": {out: "-P INPUT ACCEPT\n-A INPUT -j f2b-sshd\n-A INPUT -j DROP", zero: true}},
			want:      enabled,
			wantCalls: []string{"iptables -S INPUT"},
		},
		{name: "iptables -j DROP only inside a comment", present: []string{"iptables"}, outs: map[string]fakeFwOut{"iptables": {out: iptablesDropInComment, zero: true}}, want: disabled},
		{name: "iptables-legacy with no filter table", present: []string{"iptables"}, outs: map[string]fakeFwOut{"iptables": {out: iptablesLegacyNoTable, zero: false}}, want: disabled},
		{
			name:    "no filter table is not disabled when nft could not be read",
			present: []string{"nft", "iptables"},
			outs: map[string]fakeFwOut{
				"nft":      {out: nftPermissionDenied, zero: false},
				"iptables": {out: iptablesLegacyNoTable, zero: false},
			},
			want: want{unsupported: FirewallUnsupportedPermission},
		},
		{
			name:    "firewalld inactive is not disabled when the ruleset could not be read",
			present: []string{"firewall-cmd", "systemctl", "nft"},
			outs: map[string]fakeFwOut{
				"firewall-cmd": {out: "not running", zero: false},
				"systemctl":    {out: "inactive", zero: false},
				"nft":          {out: nftPermissionDenied, zero: false},
			},
			want: want{unsupported: FirewallUnsupportedPermission},
		},
		{
			name:    "firewalld unit name error from systemctl is ignored",
			present: []string{"firewall-cmd", "systemctl"},
			outs: map[string]fakeFwOut{
				"firewall-cmd": {out: "not running", zero: false},
				"systemctl":    {out: "Failed to connect to bus", zero: false},
			},
			want: unknown,
		},
		{
			name:      "no firewall tool installed",
			present:   nil,
			outs:      map[string]fakeFwOut{},
			want:      want{unsupported: FirewallUnsupportedNoTool},
			wantCalls: nil,
		},
		{
			name:    "nft and iptables not permitted",
			present: []string{"nft", "iptables"},
			outs: map[string]fakeFwOut{
				"nft":      {out: nftPermissionDenied, zero: false},
				"iptables": {out: iptablesPermissionDenied, zero: false},
			},
			want:      want{unsupported: FirewallUnsupportedPermission},
			wantCalls: []string{"nft list ruleset", "iptables -S INPUT"},
		},
		{
			name:    "iptables-legacy not permitted",
			present: []string{"iptables"},
			outs:    map[string]fakeFwOut{"iptables": {out: iptablesLegacyPermissionDenied, zero: false}},
			want:    want{unsupported: FirewallUnsupportedPermission},
		},
		{
			name:    "nft not permitted, iptables answers",
			present: []string{"nft", "iptables"},
			outs: map[string]fakeFwOut{
				"nft":      {out: nftPermissionDenied, zero: false},
				"iptables": {out: iptablesLegacyDropPolicy, zero: true},
			},
			want: enabled,
		},
		{
			name:    "nft generic failure is unknown, not unsupported",
			present: []string{"nft"},
			outs:    map[string]fakeFwOut{"nft": {out: "Error: Could not process rule: No such file or directory", zero: false}},
			want:    unknown,
		},
		{
			name:    "nft timeout is unknown",
			present: []string{"nft", "iptables"},
			outs: map[string]fakeFwOut{
				"nft":      {timeout: true},
				"iptables": {out: iptablesPermissionDenied, zero: false},
			},
			want: unknown,
		},
		{
			name:    "ufw fails and nothing else answers is unknown",
			present: []string{"ufw"},
			outs:    map[string]fakeFwOut{"ufw": {out: "ERROR: You need to be root to run this script", zero: false}},
			want:    unknown,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := stubLinuxFirewall(t, tc.present, tc.outs)
			gotEnabled, err := getFirewallStatusLinux()

			var unsupported *FirewallUnsupportedError
			switch {
			case tc.want.unsupported != "":
				if !errors.As(err, &unsupported) || unsupported.Reason != tc.want.unsupported {
					t.Fatalf("err = %v, want unsupported %q", err, tc.want.unsupported)
				}
				if !errors.Is(err, ErrNotSupported) {
					t.Fatalf("unsupported error must wrap ErrNotSupported: %v", err)
				}
			case tc.want.errNil:
				if err != nil {
					t.Fatalf("err = %v, want nil", err)
				}
				if gotEnabled != tc.want.enabled {
					t.Fatalf("enabled = %v, want %v", gotEnabled, tc.want.enabled)
				}
			default:
				if err == nil {
					t.Fatalf("enabled=%v err=nil, want an unknown (error) result", gotEnabled)
				}
				if errors.As(err, &unsupported) || errors.Is(err, ErrNotSupported) {
					t.Fatalf("err = %v, want a plain failure, not unsupported", err)
				}
			}
			if tc.wantCalls != nil || tc.want.unsupported == FirewallUnsupportedNoTool {
				if strings.Join(f.calls, "|") != strings.Join(tc.wantCalls, "|") {
					t.Fatalf("calls = %q, want %q", f.calls, tc.wantCalls)
				}
			}
		})
	}
}

func TestLinuxFirewallAbsentToolsCachedThenRedetected(t *testing.T) {
	f := stubLinuxFirewall(t, nil, map[string]fakeFwOut{"nft": {out: nftInputDrop, zero: true}})

	if _, err := getFirewallStatusLinux(); !isFirewallUnsupported(err, FirewallUnsupportedNoTool) {
		t.Fatalf("first call err = %v", err)
	}
	firstLookups := f.lookups
	if firstLookups == 0 {
		t.Fatal("first call did no availability check")
	}

	f.now = f.now.Add(59 * time.Minute)
	if _, err := getFirewallStatusLinux(); !isFirewallUnsupported(err, FirewallUnsupportedNoTool) {
		t.Fatalf("cached call err = %v", err)
	}
	if f.lookups != firstLookups {
		t.Fatalf("cached call re-checked availability: lookups %d -> %d", firstLookups, f.lookups)
	}

	// nftables installed later is picked up after the re-probe interval.
	f.present["nft"] = true
	f.now = f.now.Add(2 * time.Minute)
	on, err := getFirewallStatusLinux()
	if err != nil || !on {
		t.Fatalf("after install: on=%v err=%v", on, err)
	}
	if len(f.calls) != 1 || f.calls[0] != "nft list ruleset" {
		t.Fatalf("calls = %q", f.calls)
	}
}

func TestLinuxFirewallPermissionDeniedCached(t *testing.T) {
	f := stubLinuxFirewall(t, []string{"nft"}, map[string]fakeFwOut{"nft": {out: nftPermissionDenied, zero: false}})

	for i := 0; i < 3; i++ {
		if _, err := getFirewallStatusLinux(); !isFirewallUnsupported(err, FirewallUnsupportedPermission) {
			t.Fatalf("call %d err = %v", i, err)
		}
		f.now = f.now.Add(5 * time.Minute)
	}
	if len(f.calls) != 1 {
		t.Fatalf("denied nft spawned %d times inside the cache window, want 1: %q", len(f.calls), f.calls)
	}

	f.now = f.now.Add(time.Hour)
	f.outs["nft"] = fakeFwOut{out: nftAcceptOnly, zero: true}
	on, err := getFirewallStatusLinux()
	if err != nil || on {
		t.Fatalf("after re-probe: on=%v err=%v", on, err)
	}
	if len(f.calls) != 2 {
		t.Fatalf("nft not re-probed after the window: %q", f.calls)
	}
}

func TestLinuxFirewallUnsupportedLoggedOncePerWindow(t *testing.T) {
	a := newFirewallToolAvailability()
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }

	if !a.noteUnsupported(FirewallUnsupportedNoTool) {
		t.Fatal("first unsupported result was not logged")
	}
	now = now.Add(30 * time.Minute)
	if a.noteUnsupported(FirewallUnsupportedNoTool) {
		t.Fatal("repeat inside the window was logged again")
	}
	if !a.noteUnsupported(FirewallUnsupportedPermission) {
		t.Fatal("a changed reason was not logged")
	}
	now = now.Add(61 * time.Minute)
	if !a.noteUnsupported(FirewallUnsupportedPermission) {
		t.Fatal("not logged again after the window")
	}
	a.noteSupported()
	if !a.noteUnsupported(FirewallUnsupportedPermission) {
		t.Fatal("not logged after a supported answer in between")
	}
}

func TestApplyFirewallPosture(t *testing.T) {
	cases := []struct {
		name       string
		enabled    bool
		err        error
		wantPtr    *bool
		wantStatus string
		wantReason string
		wantErr    bool
	}{
		{"enabled", true, nil, boolPtr(true), "enabled", "", false},
		{"disabled", false, nil, boolPtr(false), "disabled", "", false},
		{"no tool", false, &FirewallUnsupportedError{Reason: FirewallUnsupportedNoTool}, nil, "unsupported", FirewallUnsupportedNoTool, false},
		{"permission", false, &FirewallUnsupportedError{Reason: FirewallUnsupportedPermission}, nil, "unsupported", FirewallUnsupportedPermission, false},
		{"platform not supported", false, ErrNotSupported, nil, "unsupported", "", false},
		{"failed read", false, errors.New("nft timed out"), nil, "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var status SecurityStatus
			err := applyFirewallPosture(&status, tc.enabled, tc.err)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			assertBoolPtr(t, status.FirewallEnabled, tc.wantPtr)
			if status.FirewallStatus != tc.wantStatus || status.FirewallStatusReason != tc.wantReason {
				t.Fatalf("status=%q reason=%q, want %q %q", status.FirewallStatus, status.FirewallStatusReason, tc.wantStatus, tc.wantReason)
			}
		})
	}
}

func TestFirewallStatusWireFields(t *testing.T) {
	var status SecurityStatus
	if err := applyFirewallPosture(&status, false, &FirewallUnsupportedError{Reason: FirewallUnsupportedNoTool}); err != nil {
		t.Fatalf("err = %v", err)
	}
	raw, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded["firewallStatus"] != "unsupported" || decoded["firewallStatusReason"] != FirewallUnsupportedNoTool {
		t.Fatalf("payload = %s", raw)
	}
	if _, ok := decoded["firewallEnabled"]; ok {
		t.Fatalf("firewallEnabled sent for an unsupported host: %s", raw)
	}
}

// CollectStatus runs the real Linux path only on Linux, which is what the
// test-agent CI job runs on.
func TestCollectStatusUnsupportedFirewallIsNotAWarning(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("GetFirewallStatus only takes the Linux path on Linux")
	}
	stubLinuxFirewall(t, nil, nil)
	status, err := CollectStatus(nil)
	if status.FirewallStatus != "unsupported" || status.FirewallStatusReason != FirewallUnsupportedNoTool {
		t.Fatalf("status=%q reason=%q", status.FirewallStatus, status.FirewallStatusReason)
	}
	if status.FirewallEnabled != nil {
		t.Fatalf("FirewallEnabled = %v, want nil", *status.FirewallEnabled)
	}
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "firewall") {
		t.Fatalf("collection warning mentions the firewall: %v", err)
	}
}

// Runs a real process: the warning nft writes to stderr must never reach the
// ruleset parser.
func TestFirewallRulesetFromCommandKeepsStreamsApart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs sh")
	}
	stdout, stderr, zeroExit, ok := firewallRulesetFromCommand(5*time.Second, "sh", "-c", "echo ruleset; echo warning >&2")
	if stdout != "ruleset\n" || stderr != "warning\n" || !zeroExit || !ok {
		t.Fatalf("stdout=%q stderr=%q zeroExit=%v ok=%v", stdout, stderr, zeroExit, ok)
	}

	t.Setenv("LC_ALL", "de_DE.UTF-8")
	if stdout, _, _, _ := firewallRulesetFromCommand(5*time.Second, "sh", "-c", "echo $LC_ALL"); stdout != "C\n" {
		t.Fatalf("ruleset tools must run with LC_ALL=C, got %q", stdout)
	}

	_, stderr, zeroExit, ok = firewallRulesetFromCommand(5*time.Second, "sh", "-c", "echo denied >&2; exit 1")
	if stderr != "denied\n" || zeroExit || !ok {
		t.Fatalf("failing tool: stderr=%q zeroExit=%v ok=%v", stderr, zeroExit, ok)
	}

	_, stderr, zeroExit, ok = firewallRulesetFromCommand(5*time.Second, filepath.Join(t.TempDir(), "absent"))
	if stderr == "" || zeroExit || !ok {
		t.Fatalf("failed spawn: stderr=%q zeroExit=%v ok=%v", stderr, zeroExit, ok)
	}

	_, _, zeroExit, ok = firewallRulesetFromCommand(50*time.Millisecond, "sleep", "5")
	if ok || zeroExit {
		t.Fatalf("timeout: zeroExit=%v ok=%v", zeroExit, ok)
	}
}

func TestFirewallToolLookupFindsSbinOutsidePath(t *testing.T) {
	dir := t.TempDir()
	tool := filepath.Join(dir, "nft")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notexec"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())

	if got, ok := lookPathOrDirs("nft", []string{dir}); !ok || got != tool {
		t.Fatalf("lookup = %q, %v; want %q", got, ok, tool)
	}
	if got, ok := lookPathOrDirs("notexec", []string{dir}); ok {
		t.Fatalf("non-executable file found: %q", got)
	}
	if got, ok := lookPathOrDirs("iptables", []string{dir}); ok {
		t.Fatalf("absent tool found: %q", got)
	}
}

func TestInvalidateFirewallToolCacheForcesRecheck(t *testing.T) {
	f := stubLinuxFirewall(t, nil, nil)
	if _, err := getFirewallStatusLinux(); !isFirewallUnsupported(err, FirewallUnsupportedNoTool) {
		t.Fatalf("err = %v", err)
	}
	first := f.lookups
	invalidateSlowPostureProbes()
	if _, err := getFirewallStatusLinux(); !isFirewallUnsupported(err, FirewallUnsupportedNoTool) {
		t.Fatalf("err = %v", err)
	}
	if f.lookups == first {
		t.Fatal("a fresh collection did not re-check tool availability")
	}
}

func isFirewallUnsupported(err error, reason string) bool {
	var unsupported *FirewallUnsupportedError
	return errors.As(err, &unsupported) && unsupported.Reason == reason
}
