package security

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
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
// All of this is platform-neutral (every spawn goes through
// runLocalAdminPowerShell) so it is tested on every OS.

const (
	// localAdminCmdletFailureTTL is how long a Get-LocalGroupMember failure
	// keeps this host on the net path.
	localAdminCmdletFailureTTL = 24 * time.Hour

	localAdminCmdletTimeout = 10 * time.Second
	// localAdminNetTimeout is longer because `net localgroup` may have to
	// resolve domain members.
	localAdminNetTimeout = 15 * time.Second

	localAdminMembersPS = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
		"Get-LocalGroupMember -SID 'S-1-5-32-544' | Select-Object Name,ObjectClass,SID,PrincipalSource | ConvertTo-Json -Compress"

	// localAdminNetGroupPS asks net.exe about the group by its localized name,
	// translated from the SID. Stop matters: with no name, `net localgroup`
	// lists every group on the host. The encoding switches only after net has
	// been captured, because PowerShell decodes native output with it.
	localAdminNetGroupPS = "$ErrorActionPreference='Stop';" +
		"$g=(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value.Split('\\')[-1];" +
		"$o=& net localgroup $g;" +
		"if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};" +
		"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
		"$o"
)

var errLocalAdminTimeout = errors.New("local administrators query timed out")

// runLocalAdminPowerShell runs one script and returns its combined output even
// when it fails, so the caller can read the error record PowerShell wrote to
// stderr.
var runLocalAdminPowerShell = func(timeout time.Duration, script string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(output), errLocalAdminTimeout
	}
	return string(output), err
}

// localAdminCmdletGate remembers that Get-LocalGroupMember cannot answer here.
type localAdminCmdletGate struct {
	now func() time.Time

	mu       sync.Mutex
	failedAt time.Time
	failed   bool
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
		sid, _ := stringFromAny(member["SID"])
		entry := localAdminAccount(username, sid)
		entry["objectType"] = member["ObjectClass"]
		accounts = append(accounts, entry)
	}
	return localAdminSummary("windows_local_group", accounts)
}

func localAdminSummaryFromNet() (map[string]any, error) {
	output, err := runLocalAdminPowerShell(localAdminNetTimeout, localAdminNetGroupPS)
	if err != nil {
		return nil, fmt.Errorf("net localgroup failed: %w: %s", err, truncateForLog(strings.TrimSpace(output), 300))
	}
	members, err := parseNetLocalGroupMembers(output)
	if err != nil {
		return nil, err
	}
	// An empty Administrators group is far likelier to be output this parser
	// misread than real, and reporting it would tell the API there are no admins.
	if len(members) == 0 {
		return nil, errors.New("net localgroup listed no members of the Administrators group")
	}
	accounts := make([]map[string]any, 0, len(members))
	for _, member := range members {
		// net prints a member whose SID does not resolve as the SID itself.
		sid := ""
		if strings.HasPrefix(member, "S-1-") {
			sid = member
		}
		accounts = append(accounts, localAdminAccount(member, sid))
	}
	return localAdminSummary("windows_net_localgroup", accounts), nil
}

func localAdminAccount(username, sid string) map[string]any {
	isBuiltIn := strings.HasSuffix(strings.TrimSpace(sid), "-500") ||
		strings.EqualFold(username, "Administrator")
	entry := map[string]any{
		"username":  username,
		"isBuiltIn": isBuiltIn,
		"enabled":   true,
	}
	if isBuiltIn {
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
