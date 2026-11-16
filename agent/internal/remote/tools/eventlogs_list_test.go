package tools

import (
	"encoding/json"
	"strings"
	"testing"
)

// psListLogOutput is the shape Windows PowerShell 5.1 prints for
// `Get-WinEvent -ListLog * | Select-Object LogName, RecordCount,
// MaximumSizeInBytes | ConvertTo-Json`: an array, two spaces after each
// colon, and RecordCount null for a log whose count the OS cannot read.
const psListLogOutput = `[
    {
        "LogName":  "Security",
        "RecordCount":  9500000,
        "MaximumSizeInBytes":  20971520
    },
    {
        "LogName":  "Setup",
        "RecordCount":  0,
        "MaximumSizeInBytes":  1052672
    },
    {
        "LogName":  "Microsoft-Windows-Kernel-Boot/Analytic",
        "RecordCount":  null,
        "MaximumSizeInBytes":  1048576
    }
]`

// wireLogs marshals the parsed logs exactly as the agent sends them and
// decodes them back as generic maps, so the assertions are about the wire
// contract (#11975: a count the agent cannot read must be absent, never 0).
func wireLogs(t *testing.T, logs []EventLog) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(logs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func TestParseEventLogListReportsRecordCounts(t *testing.T) {
	logs := wireLogs(t, parseEventLogList(psListLogOutput))
	if len(logs) != 3 {
		t.Fatalf("want 3 logs, got %d: %v", len(logs), logs)
	}

	if logs[0]["name"] != "Security" || logs[0]["recordCount"] != float64(9500000) {
		t.Errorf("Security: want recordCount 9500000, got %v", logs[0])
	}
	if logs[0]["maxSizeBytes"] != float64(20971520) {
		t.Errorf("Security: want maxSizeBytes 20971520, got %v", logs[0])
	}
	// An empty log is a real zero and must still be sent.
	if v, ok := logs[1]["recordCount"]; !ok || v != float64(0) {
		t.Errorf("Setup: want recordCount 0 present, got %v", logs[1])
	}
	// A null count is unknown: the field is absent, not 0.
	if v, ok := logs[2]["recordCount"]; ok {
		t.Errorf("Kernel-Boot/Analytic: want no recordCount, got %v", v)
	}
	if logs[2]["name"] != "Microsoft-Windows-Kernel-Boot/Analytic" {
		t.Errorf("want the full channel name, got %v", logs[2]["name"])
	}
}

func TestParseEventLogListSingleObject(t *testing.T) {
	// ConvertTo-Json prints a bare object, not an array, when only one log matches.
	// A UTF-8 byte order mark and CRLF are tolerated.
	out := "\xef\xbb\xbf" + `{"LogName":"System","RecordCount":41234,"MaximumSizeInBytes":20971520}` + "\r\n"
	logs := wireLogs(t, parseEventLogList(out))
	if len(logs) != 1 || logs[0]["name"] != "System" || logs[0]["recordCount"] != float64(41234) {
		t.Fatalf("want System with recordCount 41234, got %v", logs)
	}
}

func TestParseEventLogListUnparseableOutputSendsNoCounts(t *testing.T) {
	// Not JSON: fall back to scraping names, and claim no counts at all.
	out := "LogName : System\nRecordCount : 12\nLogName : Application\n"
	logs := wireLogs(t, parseEventLogList(out))
	if len(logs) != 2 || logs[0]["name"] != "System" || logs[1]["name"] != "Application" {
		t.Fatalf("want System and Application from the fallback, got %v", logs)
	}
	for _, l := range logs {
		if v, ok := l["recordCount"]; ok {
			t.Errorf("%v: fallback must not report a count, got %v", l["name"], v)
		}
	}
}

func TestParseEventLogListEmptyFallsBackToDefaults(t *testing.T) {
	logs := wireLogs(t, parseEventLogList("   "))
	if len(logs) == 0 {
		t.Fatal("want the default log list")
	}
	for _, l := range logs {
		if v, ok := l["recordCount"]; ok {
			t.Errorf("%v: default entry must not report a count, got %v", l["name"], v)
		}
		if strings.TrimSpace(l["name"].(string)) == "" {
			t.Errorf("default entry has no name: %v", l)
		}
	}
}
