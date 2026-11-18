package security

import (
	"context"
	"errors"
	"fmt"
	"github.com/breeze-rmm/agent/internal/procspawn"
	"strings"
	"sync"
	"time"
)

// Windows local Administrators membership (#10911).
//
// The group is addressed by its well-known SID because its name is localized
// ("Administratoren", "Administrateurs"), so asking for 'Administrators'
// returned nothing on non-English Windows.
//
// Get-LocalGroupMember is also known to throw on a group holding a member whose
// SID no longer resolves, which Entra-joined hosts can have. That failure lasts
// until the member is removed, so it switches this host to `net localgroup` for
// a day rather than failing first on every five-minute tick.
//
// net lists members but no SIDs or account state, so the same script resolves
// each listed name afterwards. net stays the only source of membership: when the
// resolver fails, or a name does not translate, the member is classified by name.
//
// All of this is platform-neutral (every spawn goes through
// runLocalAdminPowerShell) so it is tested on every OS.

const (
	// localAdminCmdletFailureTTL is how long a Get-LocalGroupMember failure
	// keeps this host on the net path.
	localAdminCmdletFailureTTL = 24 * time.Hour

	localAdminCmdletTimeout = 10 * time.Second
	// localAdminNetTimeout is longer because `net localgroup` and the resolver
	// may have to look up domain members.
	localAdminNetTimeout = 15 * time.Second

	// localAdminResolveMarker separates net's output from the resolver's JSON. The
	// script writes it once net's output is complete, so it also proves that a run
	// killed while resolving still delivered every member.
	localAdminResolveMarker = "breeze-local-admin-resolve"

	// localAdminMembersPS selects SID.Value because the SID itself serializes as
	// an object. It reads Enabled only for members whose SID ends in -500 or -501,
	// because Windows keeps the built-in Administrator in this group even while it
	// is disabled. SilentlyContinue keeps a member Get-LocalUser cannot find (a
	// domain account) out of the combined output, which has to parse as JSON.
	localAdminMembersPS = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
		"Get-LocalGroupMember -SID 'S-1-5-32-544' | Select-Object Name,@{n='SID';e={$_.SID.Value}},ObjectClass,PrincipalSource," +
		"@{n='Enabled';e={if($_.SID.Value -match '-50[01]$'){(Get-LocalUser -SID $_.SID -ErrorAction SilentlyContinue).Enabled}else{$null}}}" +
		" | ConvertTo-Json -Compress"

	// localAdminNetGroupPS asks net.exe about the group by its localized name,
	// translated from the SID, then resolves the members it listed. Stop matters:
	// with no name, `net localgroup` lists every group on the host. The encoding
	// switches only after net has been captured, because PowerShell decodes native
	// output with it.
	localAdminNetGroupPS = "$ErrorActionPreference='Stop';" +
		"$g=(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value.Split('\\')[-1];" +
		"$o=& net localgroup $g;" +
		"if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};" +
		"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
		"$o;" +
		"'" + localAdminResolveMarker + "';" +
		localAdminResolvePS

	// localAdminResolvePS writes one line of JSON per member from net's lines in
	// $o, with Name, SID and Enabled. It finds the members by the same layout
	// parseNetLocalGroupMembers reads, so that it asks LSA only about them, and that
	// parser still decides who is a member.
	//
	// A domain lookup can block on an unreachable domain controller until the
	// timeout kills the script. So each member is written as soon as it resolves,
	// and local names, which never leave the host, go first: the built-in accounts
	// are resolved before any domain lookup can use up the budget.
	//
	// A name that does not translate, typically a domain member with no reachable
	// domain controller, keeps a null SID and is classified by name. Enabled is read
	// only for -500 and -501, as in localAdminMembersPS, but from Win32_UserAccount:
	// Get-LocalUser ships in the module whose absence is one way onto this path. The
	// outer catch writes the error in place of the JSON, so a PowerShell without
	// ConvertTo-Json still reports net's members.
	localAdminResolvePS = "try{" +
		"$m=@();$b=$false;" +
		"foreach($l in $o){$t=([string]$l).Trim();if($b){if($t){$m+=$t}}elseif($t -match '^-{3,}$'){$b=$true}};" +
		"$k=@();" +
		"for($i=0;$i -lt $m.Count-1;$i++){$k+=$m[$i]};" +
		"foreach($n in (@($k|Where-Object{$_ -notlike '*\\*'})+@($k|Where-Object{$_ -like '*\\*'}))){" +
		"$s=$null;$e=$null;" +
		"if($n -notlike 'S-1-*'){" +
		"try{$s=(New-Object System.Security.Principal.NTAccount($n)).Translate([System.Security.Principal.SecurityIdentifier]).Value;" +
		"if($s -match '-50[01]$'){" +
		"$u=Get-CimInstance Win32_UserAccount -Filter 'LocalAccount=True'|Where-Object{$_.SID -eq $s};" +
		"if($u){$e=-not $u.Disabled}" +
		"}}catch{}" +
		"};" +
		"ConvertTo-Json -Compress -InputObject @{Name=$n;SID=$s;Enabled=$e}" +
		"}" +
		"}catch{[string]$_}"
)

var errLocalAdminTimeout = errors.New("local administrators query timed out")

// runLocalAdminPowerShell runs one script and returns its combined output even
// when it fails, so the caller can read the error record PowerShell wrote to
// stderr.
var runLocalAdminPowerShell = func(timeout time.Duration, script string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := procspawn.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(output), errLocalAdminTimeout
	}
	return string(output), err
}

// localAdminCmdletGate remembers that Get-LocalGroupMember cannot answer here,
// and whether the net path's resolver failure has been warned about since.
type localAdminCmdletGate struct {
	now func() time.Time

	mu             sync.Mutex
	failedAt       time.Time
	failed         bool
	resolverWarned bool
}

var localAdminCmdlet = &localAdminCmdletGate{now: time.Now}

func (g *localAdminCmdletGate) closed() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.failed && g.now().Sub(g.failedAt) >= localAdminCmdletFailureTTL {
		g.failed = false
	}
	return g.failed
}

func (g *localAdminCmdletGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.failed = true
	g.failedAt = g.now()
	g.resolverWarned = false
}

// shouldWarnResolverFailure answers true once each time the gate closes. The net
// path runs every five minutes, and a resolver that fails once will keep failing.
func (g *localAdminCmdletGate) shouldWarnResolverFailure() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	warn := !g.resolverWarned
	g.resolverWarned = true
	return warn
}

func collectLocalAdminSummaryWindows() (map[string]any, error) {
	if localAdminCmdlet.closed() {
		return localAdminSummaryFromNet()
	}

	output, err := runLocalAdminPowerShell(localAdminCmdletTimeout, localAdminMembersPS)
	if err == nil {
		var parsed any
		if parsed, err = parseJSONValue(strings.TrimSpace(output)); err == nil {
			return localAdminSummaryFromCmdlet(parsed), nil
		}
	}
	// PowerShell can exit 0 with only the error record on stderr, so check the
	// signature whether the spawn or the parse failed.
	if !isLocalGroupMemberCmdletFailure(output) {
		return nil, fmt.Errorf("local administrators query failed: %w", err)
	}

	log.Debug("Get-LocalGroupMember cannot answer on this host; using net localgroup",
		"recheckIn", localAdminCmdletFailureTTL.String(),
		"output", truncateForLog(strings.TrimSpace(output), 300))
	localAdminCmdlet.close()
	return localAdminSummaryFromNet()
}

// isLocalGroupMemberCmdletFailure recognizes an error record from the cmdlet
// itself or a missing cmdlet. Both match FullyQualifiedErrorId or CategoryInfo,
// which are not localized. The cmdlet's hyphenated name alone proves nothing,
// because PowerShell echoes the whole command line in any error.
func isLocalGroupMemberCmdletFailure(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "getlocalgroupmembercommand") ||
		(strings.Contains(lower, "commandnotfoundexception") && strings.Contains(lower, "(get-localgroupmember:string)"))
}

func localAdminSummaryFromCmdlet(parsed any) map[string]any {
	members := toObjectSlice(parsed)
	accounts := make([]map[string]any, 0, len(members))
	for _, member := range members {
		username, _ := stringFromAny(member["Name"])
		if username == "" {
			continue
		}
		// Keep the HOST\ or DOMAIN\ prefix for display and drop it to compare.
		accountName := username[strings.LastIndex(username, `\`)+1:]
		isBuiltIn := isBuiltInAccount(cmdletMemberSID(member["SID"]), accountName)
		entry := localAdminAccount(username, isBuiltIn, localAdminMemberEnabled(member["Enabled"]))
		entry["objectType"] = member["ObjectClass"]
		accounts = append(accounts, entry)
	}
	return localAdminSummary("windows_local_group", accounts)
}

func localAdminSummaryFromNet() (map[string]any, error) {
	output, runErr := runLocalAdminPowerShell(localAdminNetTimeout, localAdminNetGroupPS)
	netOutput, resolverOutput, netComplete := splitLocalAdminNetOutput(output)
	// Past the marker a failure can only be the resolver's, and net's answer stands.
	if runErr != nil && !netComplete {
		return nil, fmt.Errorf("net localgroup failed: %w: %s", runErr, truncateForLog(strings.TrimSpace(output), 300))
	}
	members, err := parseNetLocalGroupMembers(netOutput)
	if err != nil {
		return nil, err
	}
	// An empty Administrators group is far likelier to be output this parser
	// misread than real, and reporting it would tell the API there are no admins.
	if len(members) == 0 {
		return nil, errors.New("net localgroup listed no members of the Administrators group")
	}
	resolved, resolveErr := parseLocalAdminResolved(resolverOutput, runErr)
	if resolveErr != nil {
		logResolverFailure := log.Debug
		if localAdminCmdlet.shouldWarnResolverFailure() {
			logResolverFailure = log.Warn
		}
		logResolverFailure("could not resolve every local administrator to a SID; classifying the rest by name",
			"resolved", len(resolved), "error", resolveErr.Error())
	}
	accounts := make([]map[string]any, 0, len(members))
	for _, member := range members {
		// A missing entry reads as a member nothing is known about. With no SID,
		// the name is compared as printed: net prints local accounts bare, so a
		// prefixed Administrator here is a domain account.
		entry := resolved[member]
		sid := cmdletMemberSID(entry["SID"])
		// net prints a member whose SID does not resolve as the SID itself.
		if strings.HasPrefix(member, "S-1-") {
			sid = member
		}
		isBuiltIn := isBuiltInAccount(sid, member)
		// A failed read of the state is otherwise indistinguishable from an enabled
		// built-in. A domain's -500 lands here every tick, so this stays at Debug.
		if _, known := boolFromAny(entry["Enabled"]); isBuiltIn && sid != "" && !known {
			log.Debug("could not read whether a built-in administrator is enabled; counting it as enabled", "member", member)
		}
		accounts = append(accounts, localAdminAccount(member, isBuiltIn, localAdminMemberEnabled(entry["Enabled"])))
	}
	return localAdminSummary("windows_net_localgroup", accounts), nil
}

// splitLocalAdminNetOutput splits at the last line that is exactly the marker. A
// member's name appears in the output too, and matching anywhere in it would let
// an account named after the marker hide the members listed below it. A name
// that is the whole line comes before the script's own marker, and JSON lines
// after that marker cannot equal it. With no marker, net's output may be cut off.
func splitLocalAdminNetOutput(output string) (netOutput, resolverOutput string, netComplete bool) {
	lines := strings.Split(output, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) == localAdminResolveMarker {
			return strings.Join(lines[:i], "\n"), strings.Join(lines[i+1:], "\n"), true
		}
	}
	return output, "", false
}

// parseLocalAdminResolved reads what localAdminResolvePS wrote, keyed by the name
// as net printed it. It keeps every complete line even when it also returns an
// error, because a run killed partway still resolved the members before the kill.
// An error means the resolver stopped short, not that some name failed to
// translate, which it reports in-band with a null SID.
func parseLocalAdminResolved(output string, runErr error) (map[string]map[string]any, error) {
	resolved := map[string]map[string]any{}
	var parseErr error
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		parsed, err := parseJSONValue(trimmed)
		if err != nil {
			if parseErr == nil {
				parseErr = fmt.Errorf("%w: %s", err, truncateForLog(trimmed, 200))
			}
			continue
		}
		for _, member := range toObjectSlice(parsed) {
			if name, ok := stringFromAny(member["Name"]); ok {
				resolved[name] = member
			}
		}
	}
	if runErr != nil {
		return resolved, runErr
	}
	if parseErr != nil {
		return resolved, parseErr
	}
	if len(resolved) == 0 {
		return resolved, fmt.Errorf("no members in resolver output: %s", truncateForLog(strings.TrimSpace(output), 200))
	}
	return resolved, nil
}

// localAdminMemberEnabled counts only a reported false as disabled. The state of
// a built-in that could not be read stays a finding, and other members are not
// read.
func localAdminMemberEnabled(value any) bool {
	enabled, known := boolFromAny(value)
	return enabled || !known
}

// cmdletMemberSID reads a member's SID as the string the script selects, or as
// the object PowerShell serializes a SID to when it is selected as is.
func cmdletMemberSID(value any) string {
	if object, ok := value.(map[string]any); ok {
		value = object["Value"]
	}
	sid, _ := stringFromAny(value)
	return sid
}

// isBuiltInAccount goes by the well-known RIDs when there is a SID, because the
// built-in accounts can be renamed and their names are localized. A domain's own
// -500 and -501 match too. Other SID types, such as Entra's S-1-12-1, have no
// well-known RIDs. The name is only for members with no SID.
func isBuiltInAccount(sid, name string) bool {
	if sid == "" {
		return strings.EqualFold(name, "Administrator")
	}
	return strings.HasPrefix(sid, "S-1-5-21-") &&
		(strings.HasSuffix(sid, "-500") || strings.HasSuffix(sid, "-501"))
}

// localAdminAccount sets defaultAccount only for an enabled built-in, because
// the API raises default_account whenever that field is true.
func localAdminAccount(username string, isBuiltIn, enabled bool) map[string]any {
	entry := map[string]any{
		"username":  username,
		"isBuiltIn": isBuiltIn,
		"enabled":   enabled,
	}
	if isBuiltIn && enabled {
		entry["defaultAccount"] = true
	}
	return entry
}

func localAdminSummary(source string, accounts []map[string]any) map[string]any {
	return map[string]any{
		"source":            source,
		"adminCount":        len(accounts),
		"localAccountCount": len(accounts),
		"accounts":          accounts,
	}
}

// parseNetLocalGroupMembers reads `net localgroup <name>` output by its layout,
// since every label is localized: members follow a line of dashes, one per
// line, and the last non-blank line is the completion message.
func parseNetLocalGroupMembers(output string) ([]string, error) {
	lines := strings.Split(output, "\n")
	start := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) >= 3 && strings.Trim(trimmed, "-") == "" {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return nil, fmt.Errorf("net localgroup output has no member separator: %s", truncateForLog(strings.TrimSpace(output), 200))
	}

	var body []string
	for _, line := range lines[start:] {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			body = append(body, trimmed)
		}
	}
	if len(body) == 0 {
		return nil, errors.New("net localgroup output ended before its completion message")
	}
	return append([]string{}, body[:len(body)-1]...), nil
}
