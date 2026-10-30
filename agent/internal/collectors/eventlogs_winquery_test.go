package collectors

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestBuildWinEventXPath(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 123456700, time.UTC)
	seed := now.Add(-time.Hour).In(time.FixedZone("offset", -7*3600))
	for _, tc := range []struct {
		name      string
		bookmark  *eventLogBookmark
		seed      time.Time
		want      []string
		forbidden []string
		floor     bool
	}{
		{"seed", nil, seed, []string{"TimeCreated[@SystemTime>='2026-10-29T11:00:00.1234567Z']"}, nil, false},
		{"bookmark", &eventLogBookmark{RecordID: 42, Time: seed}, seed, []string{"(EventRecordID>42 or TimeCreated[@SystemTime>'2026-10-29T11:00:00.1234567Z'])"}, nil, false},
		{"old bookmark", &eventLogBookmark{RecordID: 42, Time: now.Add(-48 * time.Hour)}, seed, []string{"EventRecordID>42", " and TimeCreated[@SystemTime>='2026-10-28T12:00:00.1234567Z']"}, nil, true},
		{"old seed", nil, now.Add(-48 * time.Hour), []string{"TimeCreated[@SystemTime>='2026-10-27T12:00:00.1234567Z']", " and TimeCreated[@SystemTime>='2026-10-28T12:00:00.1234567Z']"}, nil, true},
		{"floor boundary", nil, now.Add(-24 * time.Hour), []string{"TimeCreated[@SystemTime>='2026-10-28T12:00:00.1234567Z']"}, nil, false},
		{"time-only bookmark", &eventLogBookmark{Time: seed}, now, []string{"TimeCreated[@SystemTime>='2026-10-29T11:00:00.1234567Z']"}, []string{"EventRecordID", "TimeCreated[@SystemTime>'"}, false},
		{"old time-only bookmark", &eventLogBookmark{Time: now.Add(-48 * time.Hour)}, seed, []string{"TimeCreated[@SystemTime>='2026-10-27T12:00:00.1234567Z']", " and TimeCreated[@SystemTime>='2026-10-28T12:00:00.1234567Z']"}, []string{"EventRecordID"}, true},
		{"record-only bookmark", &eventLogBookmark{RecordID: 42}, now.Add(-48 * time.Hour), []string{"System[EventRecordID>42 and"}, []string{"TimeCreated", "0001-", "2026-10-28"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, floor := buildWinEventXPath("(Level=1 or Level=2)", tc.bookmark, tc.seed, now)
			if floor != tc.floor {
				t.Errorf("floor=%v, want %v", floor, tc.floor)
			}
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("XPath %q missing %q", got, want)
				}
			}
			for _, forbidden := range tc.forbidden {
				if strings.Contains(got, forbidden) {
					t.Errorf("XPath %q contains forbidden %q", got, forbidden)
				}
			}
			if !strings.HasPrefix(got, "*[System[") || !strings.HasSuffix(got, " and (Level=1 or Level=2)]]") {
				t.Errorf("bad System wrapper: %q", got)
			}
		})
	}
}

func TestWindowsStreamSelections(t *testing.T) {
	security := securityEventSelection()
	for _, want := range []string{"Level=1", "Level=2", "Level=3", "band(Keywords,4503599627370496)", "EventID=1102", "EventID=4719", "EventID=4720", "EventID=4726", "EventID=4728", "EventID=4732", "EventID=4740", "EventID=4756"} {
		if !strings.Contains(security, want) {
			t.Errorf("Security selection %q missing %q", security, want)
		}
	}
	if strings.Contains(security, "EventID=4672") {
		t.Error("noisy 4672 must not be selected")
	}
	power := powerEventSelection()
	for _, id := range windowsPowerEventIDs {
		if !strings.Contains(power, fmt.Sprintf("EventID=%d", id)) {
			t.Errorf("power selection missing %d", id)
		}
	}
	providers := applicationProviderSelection(applicationInfoProviderAllowlist)
	for _, provider := range applicationInfoProviderAllowlist {
		if !strings.Contains(providers, "@Name='"+provider+"'") {
			t.Errorf("provider selection missing %q", provider)
		}
	}
	if !strings.HasPrefix(providers, "Provider[") || !strings.HasSuffix(providers, "] and (Level=3 or Level=4)") {
		t.Errorf("bad provider selection %q", providers)
	}
	for _, bad := range []string{"bad'name", `bad"name`, "bad[name", "bad]name", "bad<name", "bad>name", "bad&name"} {
		t.Run(bad, func(t *testing.T) {
			got := applicationProviderSelection([]string{bad, "Safe"})
			if got != "Provider[@Name='Safe'] and (Level=3 or Level=4)" {
				t.Errorf("unsafe provider included: %q", got)
			}
		})
	}
	if got := applicationProviderSelection(nil); got != "(Level=3 and Level=4)" {
		t.Errorf("empty providers must match nothing: %q", got)
	}
}

func TestBuildWinEventCommand(t *testing.T) {
	xpath := "*[System[Provider[@Name='MsiInstaller']]]"
	got := buildWinEventCommand("Application", xpath)
	for _, want := range []string{"-LogName 'Application'", "-Oldest", "-MaxEvents 50", "-FilterXPath '*[System[Provider[@Name=''MsiInstaller'']]]'", "NoMatchingEventsFound*", "exit 3", "[Console]::Error.WriteLine", "InsertionText", "$_.Properties.Value -join ' '", "TimeCreatedUtc", "ToUniversalTime()", "Keywords", "exit 0"} {
		if !strings.Contains(got, want) {
			t.Errorf("command missing %q: %s", want, got)
		}
	}
	for _, want := range []string{
		"-ErrorAction SilentlyContinue -ErrorVariable gwe",
		"catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }",
		"$errs = @($gwe | Where-Object { $_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*' })",
		"if ($ev.Count -eq 0 -and $errs.Count -gt 0) { [Console]::Error.WriteLine($errs[0].Exception.Message); exit 3 }",
		"if ($errs.Count -gt 0) { [Console]::Error.WriteLine($errs[0].Exception.Message) }; $ev | Select-Object",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("command missing error-handling guard %q: %s", want, got)
		}
	}
	if strings.Contains(got, "$ErrorActionPreference") || strings.Contains(got, "-ErrorAction Stop") {
		t.Errorf("command must retain events alongside non-terminating errors: %s", got)
	}
	if strings.Count(got, "exit 3") != 2 {
		t.Errorf("only terminating errors and empty failed queries should exit 3: %s", got)
	}
	if got := psSingleQuote("a'b"); got != "'a''b'" {
		t.Errorf("psSingleQuote=%q", got)
	}
}

func TestParseWinEventJSON(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		count     int
		fail      bool
	}{
		{"array", `[{"RecordId":1},{"RecordId":2}]`, 2, false},
		{"object", `{"RecordId":1,"Keywords":-9218868437227405312}`, 1, false},
		{"empty", " \n\t", 0, false},
		{"empty array", `[]`, 0, false},
		{"garbage", `bad output`, 0, true},
		{"truncated", `[{"RecordId":1}`, 0, true},
		{"scalar", `42`, 0, true},
		{"null", `null`, 0, true},
		{"wrong shape", `{"RecordId":"bad"}`, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseWinEventJSON([]byte(tc.raw))
			if (err != nil) != tc.fail || len(got) != tc.count {
				t.Fatalf("got %v, %v; want count=%d error=%v", got, err, tc.count, tc.fail)
			}
			if tc.name == "object" && (got[0].Keywords >= 0 || uint64(got[0].Keywords)&auditFailureKeyword == 0) {
				t.Errorf("signed keywords lost: %d", got[0].Keywords)
			}
		})
	}
	got, err := parseWinEventJSON([]byte(`{"InsertionText":"` + strings.Repeat("x", 600) + `"}`))
	if err != nil || len(got) != 1 {
		t.Fatalf("parse long insertion: %v", err)
	}
	if got[0].InsertionText != strings.Repeat("x", 500)+"..." {
		t.Errorf("insertion not truncated: %d", len(got[0].InsertionText))
	}
	whitespace, err := parseWinEventJSON([]byte(`{"Message":"` + strings.Repeat(" ", 600) + `","InsertionText":" replacement "}`))
	if err != nil || len(whitespace) != 1 {
		t.Fatalf("parse whitespace message: %v", err)
	}
	if got := winEventMessage(whitespace[0]); got != "replacement" {
		t.Errorf("long whitespace prevented insertion fallback: %q", got)
	}

	events := sanitizeWinEvents(make([]winEvent, collectorResultLimit+1))
	if len(events) != collectorResultLimit {
		t.Errorf("result cap=%d", len(events))
	}
}

func TestParseWinEventJSONErrorPrefix(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{"array", `[{"RecordId":1}`},
		{"object", `{"RecordId":"wrong type"}`},
		{"scalar", `42`},
		{"quoted scalar", `"unexpected output"`},
		{"escaped", "notice: \"quoted\"\n\t\x00\\path"},
		{"leading whitespace", "  diagnostic\n"},
		{"bounded", strings.Repeat("x", 120) + "MUST_NOT_APPEAR"},
		{"byte boundary", strings.Repeat("x", 119) + "éMUST_NOT_APPEAR"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseWinEventJSON([]byte(tc.raw))
			if err == nil {
				t.Fatal("expected parse error")
			}
			prefix := tc.raw
			if len(prefix) > 120 {
				prefix = prefix[:120]
			}
			want := fmt.Sprintf("(output prefix: %q)", prefix)
			if !strings.HasSuffix(err.Error(), want) {
				t.Errorf("error %q missing quoted prefix %q", err, want)
			}
			if strings.ContainsAny(err.Error(), "\n\t\x00") || strings.Contains(err.Error(), "MUST_NOT_APPEAR") {
				t.Errorf("error contains unescaped or excessive output: %q", err)
			}
		})
	}
}

func TestWinEventMessage(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event winEvent
		want  string
	}{
		{"message", winEvent{Message: " message \n", InsertionText: "insertion"}, "message"},
		{"insertion", winEvent{Message: " \n", InsertionText: " insertion \t"}, "insertion"},
		{"placeholder", winEvent{ProviderName: "Provider", Id: 42}, "(no message text: provider Provider, event ID 42)"},
		{"long message", winEvent{Message: strings.Repeat("m", 501)}, strings.Repeat("m", 500) + "..."},
		{"long insertion", winEvent{InsertionText: strings.Repeat("i", 501)}, strings.Repeat("i", 500) + "..."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := winEventMessage(tc.event); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMapSecurityEventLevel(t *testing.T) {
	failure := uint64(0x8010000000000000)
	success := uint64(0x8020000000000000)
	for _, tc := range []struct {
		name     string
		level    int
		keywords int64
		id       int
		want     string
	}{
		{"audit failure", 0, int64(failure), 4625, "warning"},
		{"curated success", 0, int64(success), 4740, "warning"},
		{"ordinary success", 0, int64(success), 4624, "info"},
		{"error", 2, int64(failure), 1104, "error"},
		{"critical", 1, int64(failure), 1, "critical"},
		{"warning", 3, 0, 1, "warning"},
		{"verbose", 5, 0, 1, "info"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := mapSecurityEventLevel(tc.level, tc.keywords, tc.id); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestWinEventQueryOutputRejectsErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		output []byte
		err    error
		want   string
	}{
		{"timeout", nil, errors.New("timed out"), "timed out"},
		{"oversize", nil, errors.New("output too large"), "output too large"},
		{"partial exit", []byte(`[{"RecordId":1}]`), &exec.ExitError{Stderr: []byte("  access denied \n")}, "stderr: access denied"},
		{"bounded stderr", nil, &exec.ExitError{Stderr: []byte(strings.Repeat("x", 1000))}, strings.Repeat("x", collectorStringLimit) + "... [truncated]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := winEventQueryOutput(tc.output, tc.err)
			if len(got) != 0 || err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, %v", got, err)
			}
			if !errors.Is(err, tc.err) {
				t.Error("command error not preserved")
			}
		})
	}
	got, err := winEventQueryOutput(nil, nil)
	if len(got) != 0 || err != nil {
		t.Errorf("empty successful output: %v, %v", got, err)
	}
}
