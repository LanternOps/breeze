package security

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	orphanedSIDFailure = "Get-LocalGroupMember : Failed to compare two elements in the array.\r\n" +
		"    + CategoryInfo          : NotSpecified: (:) [Get-LocalGroupMember], InvalidOperationException\r\n" +
		"    + FullyQualifiedErrorId : System.InvalidOperationException,Microsoft.PowerShell.Commands.GetLocalGroupMemberCommand\r\n"
	cmdletMissingFailure = "Get-LocalGroupMember : The term 'Get-LocalGroupMember' is not recognized\r\n" +
		"    + CategoryInfo          : ObjectNotFound: (Get-LocalGroupMember:String) [], CommandNotFoundException\r\n" +
		"    + FullyQualifiedErrorId : CommandNotFoundException\r\n"
	netLocalGroupEnglish = "Alias name     Administrators\r\n" +
		"Comment        Administrators have complete and unrestricted access to the computer/domain\r\n" +
		"\r\n" +
		"Members\r\n" +
		"\r\n" +
		"-------------------------------------------------------------------------------\r\n" +
		"Administrator\r\n" +
		"CONTOSO\\Domain Admins\r\n" +
		"S-1-12-1-111-222-333-444\r\n" +
		"The command completed successfully.\r\n" +
		"\r\n"
)

// fakeLocalAdminShell replaces the PowerShell seam and a fresh cmdlet gate for
// one test. It answers each script by whether it is the cmdlet or the net path.
type fakeLocalAdminShell struct {
	now         time.Time
	cmdletCalls int
	netCalls    int
	cmdletOut   string
	cmdletErr   error
	netOut      string
	netErr      error
}

func installFakeLocalAdminShell(t *testing.T) *fakeLocalAdminShell {
	t.Helper()
	fake := &fakeLocalAdminShell{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}

	prevRun, prevGate := runLocalAdminPowerShell, localAdminCmdlet
	t.Cleanup(func() { runLocalAdminPowerShell, localAdminCmdlet = prevRun, prevGate })

	localAdminCmdlet = &localAdminCmdletGate{now: func() time.Time { return fake.now }}
	runLocalAdminPowerShell = func(_ time.Duration, script string) (string, error) {
		if strings.Contains(script, "net localgroup") {
			fake.netCalls++
			return fake.netOut, fake.netErr
		}
		fake.cmdletCalls++
		return fake.cmdletOut, fake.cmdletErr
	}
	return fake
}

func TestLocalAdminScriptsResolveTheGroupBySID(t *testing.T) {
	// The group is "Administratoren" or "Administrateurs" on localized Windows.
	for name, script := range map[string]string{"cmdlet": localAdminMembersPS, "net": localAdminNetGroupPS} {
		if !strings.Contains(script, "S-1-5-32-544") {
			t.Errorf("%s script does not use the well-known SID: %s", name, script)
		}
		if strings.Contains(script, "'Administrators'") {
			t.Errorf("%s script names the localized group: %s", name, script)
		}
	}
}

func TestLocalAdminNetScriptStopsIfTheGroupNameDoesNotResolve(t *testing.T) {
	// Without a name, `net localgroup` lists every group on the host, which
	// the parser would report as administrators.
	if !strings.Contains(localAdminNetGroupPS, "$ErrorActionPreference='Stop'") {
		t.Fatalf("script must stop on a failed SID translation: %s", localAdminNetGroupPS)
	}
}

func TestLocalAdminSummaryCmdletPathUnchanged(t *testing.T) {
	fake := installFakeLocalAdminShell(t)
	fake.cmdletOut = `[{"Name":"HOST\\Administrator","ObjectClass":"User","SID":"S-1-5-21-1-2-3-500","PrincipalSource":"Local"},` +
		`{"Name":"CONTOSO\\Domain Admins","ObjectClass":"Group","SID":"S-1-5-21-9-8-7-512","PrincipalSource":"ActiveDirectory"}]`

	summary, err := collectLocalAdminSummaryWindows()
	if err != nil {
		t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
	}
	if fake.netCalls != 0 {
		t.Fatalf("net path ran %d times with a healthy cmdlet", fake.netCalls)
	}
	want := map[string]any{
		"source":            "windows_local_group",
		"adminCount":        2,
		"localAccountCount": 2,
		"accounts": []map[string]any{
			{"username": `HOST\Administrator`, "isBuiltIn": true, "enabled": true, "objectType": "User", "defaultAccount": true},
			{"username": `CONTOSO\Domain Admins`, "isBuiltIn": false, "enabled": true, "objectType": "Group"},
		},
	}
	if !reflect.DeepEqual(summary, want) {
		t.Fatalf("summary = %#v\nwant %#v", summary, want)
	}
}

func TestLocalAdminSummaryFallsBackOnCmdletFailure(t *testing.T) {
	tests := map[string]string{
		"orphaned SID":  orphanedSIDFailure,
		"cmdlet absent": cmdletMissingFailure,
	}
	for name, failure := range tests {
		t.Run(name, func(t *testing.T) {
			fake := installFakeLocalAdminShell(t)
			fake.cmdletOut, fake.cmdletErr = failure, errors.New("exit status 1")
			fake.netOut = netLocalGroupEnglish

			summary, err := collectLocalAdminSummaryWindows()
			if err != nil {
				t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
			}
			if summary["source"] != "windows_net_localgroup" || summary["adminCount"] != 3 {
				t.Fatalf("summary = %#v", summary)
			}
			accounts := summary["accounts"].([]map[string]any)
			if accounts[0]["username"] != "Administrator" || accounts[0]["isBuiltIn"] != true {
				t.Fatalf("accounts[0] = %#v", accounts[0])
			}
			if accounts[2]["username"] != "S-1-12-1-111-222-333-444" {
				t.Fatalf("orphaned member dropped: %#v", accounts[2])
			}
		})
	}
}

func TestLocalAdminFallbackWhenExitZeroWithOnlyTheErrorRecord(t *testing.T) {
	fake := installFakeLocalAdminShell(t)
	fake.cmdletOut = orphanedSIDFailure // No spawn error, and not JSON.
	fake.netOut = netLocalGroupEnglish

	summary, err := collectLocalAdminSummaryWindows()
	if err != nil {
		t.Fatalf("collectLocalAdminSummaryWindows: %v", err)
	}
	if summary["source"] != "windows_net_localgroup" {
		t.Fatalf("summary = %#v", summary)
	}
}

func TestLocalAdminCmdletFailureIsNotRetriedForTheTTL(t *testing.T) {
	fake := installFakeLocalAdminShell(t)
	fake.cmdletOut, fake.cmdletErr = orphanedSIDFailure, errors.New("exit status 1")
	fake.netOut = netLocalGroupEnglish

	for i := 0; i < 3; i++ {
		if _, err := collectLocalAdminSummaryWindows(); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	if fake.cmdletCalls != 1 || fake.netCalls != 3 {
		t.Fatalf("cmdlet ran %d times and net %d times, want 1 and 3", fake.cmdletCalls, fake.netCalls)
	}

	// The orphaned member may be gone by now, so the cmdlet gets another try.
	fake.now = fake.now.Add(localAdminCmdletFailureTTL)
	fake.cmdletOut, fake.cmdletErr = `{"Name":"HOST\\Administrator","ObjectClass":"User"}`, nil
	summary, err := collectLocalAdminSummaryWindows()
	if err != nil {
		t.Fatalf("after TTL: %v", err)
	}
	if fake.cmdletCalls != 2 || summary["source"] != "windows_local_group" {
		t.Fatalf("cmdlet calls = %d, summary = %#v", fake.cmdletCalls, summary)
	}
}

func TestLocalAdminOtherFailuresStayErrorsAndAreRetried(t *testing.T) {
	failures := map[string]struct {
		output string
		err    error
	}{
		"timeout": {"", errLocalAdminTimeout},
		"powershell blocked": {
			"Cannot run powershell: this program is blocked by group policy.",
			errors.New("exit status 1"),
		},
		// PowerShell echoes the command line on any missing command, so the
		// cmdlet's name alone is not evidence the cmdlet failed.
		"other command not found": {
			"Get-LocalGroupMember -SID ... : The term 'ConvertTo-Json' is not recognized\r\n" +
				"    + CategoryInfo          : ObjectNotFound: (ConvertTo-Json:String) [], CommandNotFoundException\r\n",
			errors.New("exit status 1"),
		},
	}
	for name, failure := range failures {
		t.Run(name, func(t *testing.T) {
			fake := installFakeLocalAdminShell(t)
			fake.cmdletOut, fake.cmdletErr = failure.output, failure.err

			for i := 0; i < 2; i++ {
				if _, err := collectLocalAdminSummaryWindows(); err == nil {
					t.Fatal("want an error")
				}
			}
			if fake.cmdletCalls != 2 || fake.netCalls != 0 {
				t.Fatalf("cmdlet ran %d times and net %d times, want 2 and 0", fake.cmdletCalls, fake.netCalls)
			}
		})
	}
}

func TestLocalAdminFallbackFailureIsAnError(t *testing.T) {
	fake := installFakeLocalAdminShell(t)
	fake.cmdletOut, fake.cmdletErr = orphanedSIDFailure, errors.New("exit status 1")
	fake.netOut, fake.netErr = "System error 5 has occurred.", errors.New("exit status 2")

	if _, err := collectLocalAdminSummaryWindows(); err == nil {
		t.Fatal("want an error when both paths fail")
	}
}

func TestParseNetLocalGroupMembers(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		want    []string
		wantErr bool
	}{
		{
			name:   "english",
			output: netLocalGroupEnglish,
			want:   []string{"Administrator", `CONTOSO\Domain Admins`, "S-1-12-1-111-222-333-444"},
		},
		{
			name: "german: only the layout is relied on",
			output: "Aliasname     Administratoren\r\nBeschreibung  Administratoren haben uneingeschränkten Vollzugriff\r\n\r\n" +
				"Mitglieder\r\n\r\n-------------------------------------------------------------------------------\r\n" +
				"Administrator\r\nJürgen\r\nDer Befehl wurde erfolgreich ausgeführt.\r\n\r\n",
			want: []string{"Administrator", "Jürgen"},
		},
		{
			name:   "no members leaves only the footer",
			output: "Members\r\n\r\n-------------------\r\nThe command completed successfully.\r\n",
			want:   []string{},
		},
		{name: "no separator", output: "System error 1376 has occurred.\r\n", wantErr: true},
		{name: "nothing after the separator", output: "Members\r\n-------------------\r\n", wantErr: true},
		{name: "empty", output: "", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseNetLocalGroupMembers(tt.output)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("want an error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseNetLocalGroupMembers: %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
