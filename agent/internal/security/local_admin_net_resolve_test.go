package security

import (
	"bytes"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

// netResolvedOutput is the shape localAdminNetGroupPS writes: net's own output,
// the marker, then one line of JSON per resolved member. Hand-written from that
// script, because these tests fake runLocalAdminPowerShell and never start
// PowerShell.
func netResolvedOutput(members []string, resolved ...string) string {
	return "Alias name     Administrators\r\n\r\nMembers\r\n\r\n" +
		"-------------------------------------------------------------------------------\r\n" +
		strings.Join(members, "\r\n") + "\r\n" +
		"The command completed successfully.\r\n\r\n" +
		localAdminResolveMarker + "\r\n" + strings.Join(resolved, "\r\n") + "\r\n"
}

// netPathAccounts runs one tick on a host whose cmdlet has just failed.
func netPathAccounts(t *testing.T, output string, netErr error) ([]map[string]any, error) {
	t.Helper()
	fake := installFakeLocalAdminShell(t)
	fake.cmdletOut, fake.cmdletErr = orphanedSIDFailure, errors.New("exit status 1")
	fake.netOut, fake.netErr = output, netErr
	summary, err := collectLocalAdminSummaryWindows()
	if err != nil {
		return nil, err
	}
	if summary["source"] != "windows_net_localgroup" {
		t.Fatalf("summary = %#v", summary)
	}
	return summary["accounts"].([]map[string]any), nil
}

func TestLocalAdminNetPathReadsResolvedMembers(t *testing.T) {
	tests := []struct {
		name        string
		member      string
		resolved    string
		wantBuiltIn bool
		wantEnabled bool
		wantDefault bool
	}{
		{
			// The false finding in #11057: Windows keeps the built-in in the group
			// while disabled, and the API raises default_account on defaultAccount.
			name:        "disabled built-in Administrator is built in and disabled, with no finding",
			member:      "Administrator",
			resolved:    `{"Name":"Administrator","SID":"S-1-5-21-1-2-3-500","Enabled":false}`,
			wantBuiltIn: true, wantEnabled: false, wantDefault: false,
		},
		{
			name:        "enabled built-in Administrator is a finding",
			member:      "Administrator",
			resolved:    `{"Name":"Administrator","SID":"S-1-5-21-1-2-3-500","Enabled":true}`,
			wantBuiltIn: true, wantEnabled: true, wantDefault: true,
		},
		{
			// The missed finding in #11057: only the exact name used to match.
			name:        "renamed built-in flags by RID",
			member:      "opsadmin",
			resolved:    `{"Name":"opsadmin","SID":"S-1-5-21-1-2-3-500","Enabled":true}`,
			wantBuiltIn: true, wantEnabled: true, wantDefault: true,
		},
		{
			name:        "localized built-in flags by RID",
			member:      "Administrateur",
			resolved:    `{"Name":"Administrateur","SID":"S-1-5-21-1-2-3-500","Enabled":true}`,
			wantBuiltIn: true, wantEnabled: true, wantDefault: true,
		},
		{
			name:        "disabled renamed built-in has no finding",
			member:      "opsadmin",
			resolved:    `{"Name":"opsadmin","SID":"S-1-5-21-1-2-3-500","Enabled":false}`,
			wantBuiltIn: true, wantEnabled: false, wantDefault: false,
		},
		{
			name:        "enabled localized guest flags by RID",
			member:      "Invité",
			resolved:    `{"Name":"Invité","SID":"S-1-5-21-1-2-3-501","Enabled":true}`,
			wantBuiltIn: true, wantEnabled: true, wantDefault: true,
		},
		{
			name:        "plain user is not flagged",
			member:      "labuser",
			resolved:    `{"Name":"labuser","SID":"S-1-5-21-1-2-3-1009","Enabled":null}`,
			wantBuiltIn: false, wantEnabled: true, wantDefault: false,
		},
		{
			name:        "the SID outranks the name",
			member:      "Administrator",
			resolved:    `{"Name":"Administrator","SID":"S-1-5-21-1-2-3-1001","Enabled":null}`,
			wantBuiltIn: false, wantEnabled: true, wantDefault: false,
		},
		{
			name:        "a built-in whose state could not be read stays flagged",
			member:      "Administrator",
			resolved:    `{"Name":"Administrator","SID":"S-1-5-21-1-2-3-500","Enabled":null}`,
			wantBuiltIn: true, wantEnabled: true, wantDefault: true,
		},
		{
			// The cmdlet path flags a domain's -500 too, since it cannot read the state.
			name:        "a translated domain -500 matches the cmdlet path",
			member:      `CONTOSO\opsadmin`,
			resolved:    `{"Name":"CONTOSO\\opsadmin","SID":"S-1-5-21-9-8-7-500","Enabled":null}`,
			wantBuiltIn: true, wantEnabled: true, wantDefault: true,
		},
		{
			name:        "an untranslatable domain group keeps the name-only result",
			member:      `CONTOSO\Domain Admins`,
			resolved:    `{"Name":"CONTOSO\\Domain Admins","SID":null,"Enabled":null}`,
			wantBuiltIn: false, wantEnabled: true, wantDefault: false,
		},
		{
			// net prints local accounts bare, so a prefix means a domain account.
			name:        "an untranslatable prefixed Administrator keeps the name-only result",
			member:      `CONTOSO\Administrator`,
			resolved:    `{"Name":"CONTOSO\\Administrator","SID":null,"Enabled":null}`,
			wantBuiltIn: false, wantEnabled: true, wantDefault: false,
		},
		{
			name:        "an untranslatable bare Administrator keeps the name-only result",
			member:      "Administrator",
			resolved:    `{"Name":"Administrator","SID":null,"Enabled":null}`,
			wantBuiltIn: true, wantEnabled: true, wantDefault: true,
		},
		{
			name:        "a member net printed as a SID goes by that SID",
			member:      "S-1-5-21-1-2-3-500",
			resolved:    `{"Name":"S-1-5-21-1-2-3-500","SID":null,"Enabled":null}`,
			wantBuiltIn: true, wantEnabled: true, wantDefault: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			accounts, err := netPathAccounts(t, netResolvedOutput([]string{tt.member}, tt.resolved), nil)
			if err != nil {
				t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
			}
			if len(accounts) != 1 {
				t.Fatalf("accounts = %#v", accounts)
			}
			got := accounts[0]
			if got["username"] != tt.member {
				t.Errorf("username = %v, want %q as net printed it", got["username"], tt.member)
			}
			if got["isBuiltIn"] != tt.wantBuiltIn || got["enabled"] != tt.wantEnabled {
				t.Errorf("account = %#v, want isBuiltIn %v, enabled %v", got, tt.wantBuiltIn, tt.wantEnabled)
			}
			if _, isDefault := got["defaultAccount"]; isDefault != tt.wantDefault {
				t.Errorf("account = %#v, want defaultAccount present = %v", got, tt.wantDefault)
			}
		})
	}
}

func TestLocalAdminNetPathMembershipComesFromNet(t *testing.T) {
	// A name the resolver reports that net did not list is not a member, and a
	// member the resolver skipped still is one.
	output := netResolvedOutput([]string{"opsadmin", "Administrator"},
		`{"Name":"opsadmin","SID":"S-1-5-21-1-2-3-500","Enabled":false}`,
		`{"Name":"stranger","SID":"S-1-5-21-1-2-3-500","Enabled":true}`)
	accounts, err := netPathAccounts(t, output, nil)
	if err != nil {
		t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
	}
	want := []map[string]any{
		{"username": "opsadmin", "isBuiltIn": true, "enabled": false},
		{"username": "Administrator", "isBuiltIn": true, "enabled": true, "defaultAccount": true},
	}
	if !reflect.DeepEqual(accounts, want) {
		t.Fatalf("accounts = %#v\nwant %#v", accounts, want)
	}
}

func TestLocalAdminNetPathKeepsWhatResolvedBeforeAKill(t *testing.T) {
	// The built-ins resolve first because a domain lookup can use up the budget.
	// Losing them would bring back both misclassifications in #11057.
	members := []string{"opsadmin", "Administrator", `CONTOSO\Domain Admins`, `CONTOSO\svc`}
	want := []map[string]any{
		{"username": "opsadmin", "isBuiltIn": true, "enabled": true, "defaultAccount": true},
		{"username": "Administrator", "isBuiltIn": false, "enabled": true},
		{"username": `CONTOSO\Domain Admins`, "isBuiltIn": false, "enabled": true},
		{"username": `CONTOSO\svc`, "isBuiltIn": false, "enabled": true},
	}
	tests := map[string]struct {
		lastLine string
		err      error
	}{
		"killed between members":        {err: errLocalAdminTimeout},
		"killed partway through a line": {lastLine: `{"Name":"CONTOSO\\Domain Admins","SID":"S-1-5-21-9`, err: errLocalAdminTimeout},
		"an error ended the loop":       {lastLine: "The term 'ConvertTo-Json' is not recognized"},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			output := netResolvedOutput(members,
				`{"Name":"opsadmin","SID":"S-1-5-21-1-2-3-500","Enabled":true}`,
				`{"Name":"Administrator","SID":"S-1-5-21-1-2-3-1001","Enabled":null}`,
				tt.lastLine)
			accounts, err := netPathAccounts(t, output, tt.err)
			if err != nil {
				t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
			}
			if !reflect.DeepEqual(accounts, want) {
				t.Fatalf("accounts = %#v\nwant %#v", accounts, want)
			}
		})
	}
}

func TestLocalAdminResolverDetailStaysAtDebugAfterTheWarning(t *testing.T) {
	var logs bytes.Buffer
	logging.Init("text", "debug", &logs)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	fake := installFakeLocalAdminShell(t)
	fake.cmdletOut, fake.cmdletErr = orphanedSIDFailure, errors.New("exit status 1")
	fake.netOut = netResolvedOutput([]string{"Administrator"}, "not json")
	for i := 0; i < 2; i++ {
		if _, err := collectLocalAdminSummaryWindows(); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	message := "could not resolve every local administrator"
	if got := strings.Count(logs.String(), "level=WARN"); got != 1 {
		t.Fatalf("logged %d warnings over 2 ticks, want 1:\n%s", got, logs.String())
	}
	if got := strings.Count(logs.String(), message); got != 2 {
		t.Fatalf("logged the failure %d times over 2 ticks, want 2:\n%s", got, logs.String())
	}
}

func TestLocalAdminNetPathMemberNamesCannotForgeTheMarker(t *testing.T) {
	// An account in this group could otherwise be named to hide the members
	// listed after it.
	tests := map[string]string{
		"name containing the marker":      `CONTOSO\` + localAdminResolveMarker + `-x`,
		"name that is exactly the marker": localAdminResolveMarker,
	}
	for name, forged := range tests {
		t.Run(name, func(t *testing.T) {
			output := netResolvedOutput([]string{forged, "opsadmin"}, `{"Name":"opsadmin","SID":"S-1-5-21-1-2-3-500","Enabled":false}`)
			accounts, err := netPathAccounts(t, output, nil)
			if err != nil {
				t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
			}
			want := []map[string]any{
				{"username": forged, "isBuiltIn": false, "enabled": true},
				{"username": "opsadmin", "isBuiltIn": true, "enabled": false},
			}
			if !reflect.DeepEqual(accounts, want) {
				t.Fatalf("accounts = %#v\nwant %#v", accounts, want)
			}
		})
	}

	t.Run("a name containing the marker does not vouch for a cut-off read", func(t *testing.T) {
		output := "Members\r\n-------------------\r\nCONTOSO\\" + localAdminResolveMarker + "-x\r\nlabuser\r\n"
		if accounts, err := netPathAccounts(t, output, errLocalAdminTimeout); err == nil {
			t.Fatalf("want an error, got %#v", accounts)
		}
	})
}

func TestLocalAdminNetPathLogsAnUnreadBuiltInState(t *testing.T) {
	// A failed Win32_UserAccount read leaves the resolver healthy and the account
	// counted as enabled, so this line is the only trace of it.
	message := "could not read whether a built-in administrator is enabled"
	tests := map[string]struct {
		resolved string
		want     int
	}{
		"state not read":             {`{"Name":"Administrator","SID":"S-1-5-21-1-2-3-500","Enabled":null}`, 1},
		"state read":                 {`{"Name":"Administrator","SID":"S-1-5-21-1-2-3-500","Enabled":false}`, 0},
		"not built in":               {`{"Name":"Administrator","SID":"S-1-5-21-1-2-3-1001","Enabled":null}`, 0},
		"name match, no SID to read": {`{"Name":"Administrator","SID":null,"Enabled":null}`, 0},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			var logs bytes.Buffer
			logging.Init("text", "debug", &logs)
			t.Cleanup(func() { logging.Init("text", "info", nil) })
			if _, err := netPathAccounts(t, netResolvedOutput([]string{"Administrator"}, tt.resolved), nil); err != nil {
				t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
			}
			if got := strings.Count(logs.String(), message); got != tt.want {
				t.Fatalf("logged %d times, want %d:\n%s", got, tt.want, logs.String())
			}
		})
	}
}

func TestLocalAdminNetPathKeepsNamesWhenTheResolverFails(t *testing.T) {
	// A host this probe could read before must not lose its membership to a
	// resolver failure, so each of these still reports what net listed.
	nameOnly := []map[string]any{
		{"username": "Administrator", "isBuiltIn": true, "enabled": true, "defaultAccount": true},
		{"username": "labuser", "isBuiltIn": false, "enabled": true},
	}
	members := []string{"Administrator", "labuser"}
	tests := map[string]struct {
		output string
		err    error
	}{
		"nothing after the marker": {
			output: netResolvedOutput(members, ""),
		},
		"an error message after the marker, as a PowerShell without ConvertTo-Json writes": {
			output: netResolvedOutput(members, "The term 'ConvertTo-Json' is not recognized"),
		},
		"JSON cut short": {
			output: netResolvedOutput(members, `[{"Name":"Administrator","SID":"S-1-5`),
		},
		"JSON that is not a member list": {
			output: netResolvedOutput(members, `null`),
		},
		"timed out resolving, after net's output was complete": {
			output: netResolvedOutput(members, ""),
			err:    errLocalAdminTimeout,
		},
		"no marker at all, with no error": {
			output: "Members\r\n-------------------\r\nAdministrator\r\nlabuser\r\nThe command completed successfully.\r\n",
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			accounts, err := netPathAccounts(t, tt.output, tt.err)
			if err != nil {
				t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
			}
			if !reflect.DeepEqual(accounts, nameOnly) {
				t.Fatalf("accounts = %#v\nwant %#v", accounts, nameOnly)
			}
		})
	}
}

func TestLocalAdminNetPathFailsWithoutTheMarkerOnError(t *testing.T) {
	// A cut-off read can end on a member, which the parser would then drop as the
	// completion message, so only output up to the marker is known to be whole.
	output := "Members\r\n-------------------\r\nAdministrator\r\nlabuser\r\n"
	if accounts, err := netPathAccounts(t, output, errLocalAdminTimeout); err == nil {
		t.Fatalf("want an error, got %#v", accounts)
	}
}

func TestLocalAdminResolverFailureWarnsOncePerGateClosure(t *testing.T) {
	var logs bytes.Buffer
	logging.Init("text", "info", &logs)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	warnings := func() int { return strings.Count(logs.String(), "level=WARN") }

	fake := installFakeLocalAdminShell(t)
	fake.cmdletOut, fake.cmdletErr = orphanedSIDFailure, errors.New("exit status 1")
	fake.netOut = netResolvedOutput([]string{"Administrator"}, "not json")

	for i := 0; i < 3; i++ {
		if _, err := collectLocalAdminSummaryWindows(); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	if got := warnings(); got != 1 {
		t.Fatalf("logged %d warnings over 3 ticks, want 1:\n%s", got, logs.String())
	}

	// The gate closing again a day later is a new chance to see it.
	fake.now = fake.now.Add(localAdminCmdletFailureTTL)
	if _, err := collectLocalAdminSummaryWindows(); err != nil {
		t.Fatalf("after TTL: %v", err)
	}
	if got := warnings(); got != 2 {
		t.Fatalf("logged %d warnings after the gate closed again, want 2:\n%s", got, logs.String())
	}

	// A healthy resolver is not worth a warning, including a domain name that
	// did not translate, which is routine.
	logs.Reset()
	fake.netOut = netResolvedOutput([]string{`CONTOSO\Domain Admins`}, `{"Name":"CONTOSO\\Domain Admins","SID":null,"Enabled":null}`)
	fake.now = fake.now.Add(localAdminCmdletFailureTTL)
	if _, err := collectLocalAdminSummaryWindows(); err != nil {
		t.Fatalf("healthy tick: %v", err)
	}
	if got := warnings(); got != 0 {
		t.Fatalf("logged %d warnings with a healthy resolver:\n%s", got, logs.String())
	}
}

func TestLocalAdminNetScriptWritesNetBeforeItResolves(t *testing.T) {
	// The resolver can hang on a domain lookup, and only output written before
	// that survives the kill.
	position := 0
	for _, step := range []string{
		"& net localgroup $g",
		"OutputEncoding",
		"$o;",
		localAdminResolveMarker,
		".Translate([System.Security.Principal.SecurityIdentifier])",
		"ConvertTo-Json",
	} {
		next := strings.Index(localAdminNetGroupPS[position:], step)
		if next < 0 {
			t.Fatalf("%q is missing or out of order in: %s", step, localAdminNetGroupPS)
		}
		position += next + len(step)
	}
}

func TestLocalAdminNetScriptResolverStaysQuietAndPortable(t *testing.T) {
	for _, want := range []string{
		// A name that does not translate must not end the loop or the script.
		"try{$s=(New-Object System.Security.Principal.NTAccount($n))",
		// Only the RIDs the probe reports on are read, as on the cmdlet path.
		"-match '-50[01]$'",
		// No domain enumeration.
		"Win32_UserAccount -Filter 'LocalAccount=True'",
		// Disabled is the opposite of what the probe reports, and getting this
		// backwards hides every enabled built-in.
		"$e=-not $u.Disabled",
		// The last non-blank line is the completion message, not a member.
		"$i -lt $m.Count-1",
		// A kill keeps only what was already written, so this is per member.
		"ConvertTo-Json -Compress -InputObject @{Name=$n;SID=$s;Enabled=$e}",
		// A printed SID already failed to resolve, so asking again only costs a lookup.
		"-notlike 'S-1-*'",
		// Local names first: only a domain lookup can block.
		`(@($k|Where-Object{$_ -notlike '*\*'})+@($k|Where-Object{$_ -like '*\*'}))`,
	} {
		if !strings.Contains(localAdminNetGroupPS, want) {
			t.Errorf("script is missing %q: %s", want, localAdminNetGroupPS)
		}
	}
	// Get-LocalUser ships in the module whose absence is one way onto this path.
	if strings.Contains(localAdminNetGroupPS, "Get-LocalUser") {
		t.Errorf("script depends on the LocalAccounts module: %s", localAdminNetGroupPS)
	}
	// The script is one argument, so a double quote would depend on argv escaping.
	if strings.Contains(localAdminNetGroupPS, `"`) {
		t.Errorf("script contains a double quote: %s", localAdminNetGroupPS)
	}
}
