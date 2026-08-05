package tools

import (
	"strings"
	"testing"
	"time"
)

func TestParseEventLogTime(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		wantOK bool
		want   time.Time
	}{
		{
			name:   "round-trip ISO from ToString('o') projection",
			input:  "2026-08-03T18:34:56.1234567Z",
			wantOK: true,
			want:   time.Date(2026, 8, 3, 18, 34, 56, 123456700, time.UTC),
		},
		{
			name:   "RFC3339 without fraction",
			input:  "2026-08-03T18:34:56Z",
			wantOK: true,
			want:   time.Date(2026, 8, 3, 18, 34, 56, 0, time.UTC),
		},
		{
			name:   "RFC3339 with offset",
			input:  "2026-08-03T11:34:56-07:00",
			wantOK: true,
			want:   time.Date(2026, 8, 3, 18, 34, 56, 0, time.UTC),
		},
		{
			name:   "PS 5.1 escaped .NET JSON date",
			input:  `\/Date(1754246096000)\/`,
			wantOK: true,
			want:   time.UnixMilli(1754246096000).UTC(),
		},
		{
			name:   "unescaped .NET JSON date",
			input:  "/Date(1754246096000)/",
			wantOK: true,
			want:   time.UnixMilli(1754246096000).UTC(),
		},
		{
			name:   ".NET JSON date with display offset",
			input:  `\/Date(1754246096000-0700)\/`,
			wantOK: true,
			want:   time.UnixMilli(1754246096000).UTC(),
		},
		{
			name:   "ISO without zone",
			input:  "2026-08-03T18:34:56",
			wantOK: true,
			want:   time.Date(2026, 8, 3, 18, 34, 56, 0, time.UTC),
		},
		{name: "null literal", input: "null", wantOK: false},
		{name: "empty", input: "", wantOK: false},
		{name: "garbage", input: "not-a-date", wantOK: false},
		{name: "malformed .NET date", input: "/Date(abc)/", wantOK: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseEventLogTime(tt.input)
			if ok != tt.wantOK {
				t.Fatalf("parseEventLogTime(%q) ok = %v, want %v", tt.input, ok, tt.wantOK)
			}
			if ok && !got.Equal(tt.want) {
				t.Errorf("parseEventLogTime(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseEventLogEntriesTimestamps(t *testing.T) {
	tests := []struct {
		name string
		// One JSON-ish PowerShell output block per test.
		output   string
		wantTime time.Time
	}{
		{
			name: "PS 5.1 legacy \\/Date()\\/ serialization",
			output: `{
    "RecordId":  12345,
    "LogName":  "System",
    "LevelDisplayName":  "Information",
    "TimeCreated":  "\/Date(1754246096000)\/",
    "ProviderName":  "Microsoft-Windows-Kernel-General",
    "Id":  16,
    "Message":  "The access history was cleared."
}`,
			wantTime: time.UnixMilli(1754246096000).UTC(),
		},
		{
			name: "ISO string from the ToString('o') projection",
			output: `{
    "RecordId":  12345,
    "LogName":  "System",
    "LevelDisplayName":  "Information",
    "TimeCreated":  "2026-08-03T18:34:56.1234567Z",
    "ProviderName":  "Microsoft-Windows-Kernel-General",
    "Id":  16,
    "Message":  "The access history was cleared."
}`,
			wantTime: time.Date(2026, 8, 3, 18, 34, 56, 123456700, time.UTC),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entries := parseEventLogEntries(tt.output)
			if len(entries) != 1 {
				t.Fatalf("expected 1 entry, got %d", len(entries))
			}
			e := entries[0]
			if e.RecordID != 12345 {
				t.Errorf("RecordID = %d, want 12345", e.RecordID)
			}
			if e.TimeCreated.IsZero() {
				t.Fatal("TimeCreated is zero — timestamp was dropped (issue #3092)")
			}
			if !e.TimeCreated.Equal(tt.wantTime) {
				t.Errorf("TimeCreated = %v, want %v", e.TimeCreated, tt.wantTime)
			}
			if e.Source != "Microsoft-Windows-Kernel-General" {
				t.Errorf("Source = %q", e.Source)
			}
			if e.EventID != 16 {
				t.Errorf("EventID = %d, want 16", e.EventID)
			}
		})
	}
}

func TestParseEventLogEntriesNullTimestampStaysZero(t *testing.T) {
	output := `{
    "RecordId":  7,
    "LogName":  "System",
    "TimeCreated":  null,
    "Id":  1
}`
	entries := parseEventLogEntries(output)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if !entries[0].TimeCreated.IsZero() {
		t.Errorf("TimeCreated = %v, want zero for null input", entries[0].TimeCreated)
	}
}

func TestBuildEventLogQueryScript(t *testing.T) {
	xpath := `*[System[Provider[@Name='Microsoft-Windows-USB-USBHUB3-Interoperability']]]`

	t.Run("xpath path uses FilterXPath verbatim with escaping", func(t *testing.T) {
		script := buildEventLogQueryScript("System", "", xpath, 0, 0, 100)

		if !strings.Contains(script, "-FilterXPath '*[System[Provider[@Name=''Microsoft-Windows-USB-USBHUB3-Interoperability'']]]'") {
			t.Errorf("script missing escaped -FilterXPath clause:\n%s", script)
		}
		if !strings.Contains(script, "-LogName 'System'") {
			t.Errorf("script missing -LogName clause:\n%s", script)
		}
		if !strings.Contains(script, "-MaxEvents 100") {
			t.Errorf("script missing -MaxEvents clause:\n%s", script)
		}
		if strings.Contains(script, "-FilterHashtable") {
			t.Errorf("xpath script must not fall back to -FilterHashtable:\n%s", script)
		}
	})

	t.Run("both paths use Stop with the no-events carve-out", func(t *testing.T) {
		for name, script := range map[string]string{
			"xpath":     buildEventLogQueryScript("System", "", xpath, 0, 0, 100),
			"hashtable": buildEventLogQueryScript("System", "MySource", "", 2, 42, 50),
		} {
			if !strings.Contains(script, "-ErrorAction Stop") {
				t.Errorf("%s script must use -ErrorAction Stop so failures are explicit:\n%s", name, script)
			}
			if !strings.Contains(script, "NoMatchingEventsFound") {
				t.Errorf("%s script must treat NoMatchingEventsFound as empty, not an error:\n%s", name, script)
			}
			if !strings.Contains(script, "exit 1") {
				t.Errorf("%s script must exit non-zero on query failure:\n%s", name, script)
			}
			if !strings.Contains(script, eventLogTimeCreatedProjection) {
				t.Errorf("%s script missing TimeCreated ISO projection:\n%s", name, script)
			}
		}
	})

	t.Run("hashtable entries are semicolon separated", func(t *testing.T) {
		// A previous ' and '-joined form was a PowerShell parse error that made
		// every level/source/eventId-filtered query silently return 0 events.
		script := buildEventLogQueryScript("Application", "MySource", "", 2, 42, 50)

		if !strings.Contains(script, "-FilterHashtable @{LogName='Application'; Level=2; ProviderName='MySource'; Id=42}") {
			t.Errorf("script missing semicolon-separated hashtable filter:\n%s", script)
		}
		if strings.Contains(script, "' and ") {
			t.Errorf("hashtable filter must not use the invalid ' and ' separator:\n%s", script)
		}
		if strings.Contains(script, "-FilterXPath") {
			t.Errorf("hashtable script must not contain -FilterXPath:\n%s", script)
		}
	})

	t.Run("log name single quotes escaped on xpath path", func(t *testing.T) {
		script := buildEventLogQueryScript("O'Brien", "", xpath, 0, 0, 10)
		if !strings.Contains(script, "-LogName 'O''Brien'") {
			t.Errorf("log name not escaped:\n%s", script)
		}
	})

	t.Run("unicode quote lookalikes in the query cannot break out", func(t *testing.T) {
		// PowerShell closes a single-quoted literal on U+2018-U+201B too, so an
		// unescaped U+2019 in the XPath is command injection into a SYSTEM shell.
		injection := "*[System]’; Write-Output PWNED; ‘"
		script := buildEventLogQueryScript("System", "", injection, 0, 0, 10)
		if !strings.Contains(script, "-FilterXPath '*[System]’’; Write-Output PWNED; ‘‘'") {
			t.Errorf("unicode quote lookalikes not doubled in script:\n%s", script)
		}
	})
}

func TestParseEventLogLevel(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    int
		wantErr bool
	}{
		{name: "absent", payload: map[string]any{}, want: 0},
		{name: "empty string", payload: map[string]any{"level": ""}, want: 0},
		{name: "known alias", payload: map[string]any{"level": "error"}, want: 2},
		{name: "case insensitive", payload: map[string]any{"level": "Information"}, want: 4},
		{name: "unknown alias rejected", payload: map[string]any{"level": "warn2"}, wantErr: true},
		{name: "numeric level accepted", payload: map[string]any{"level": float64(2)}, want: 2},
		{name: "numeric out of range", payload: map[string]any{"level": float64(7)}, wantErr: true},
		{name: "fractional number rejected", payload: map[string]any{"level": 2.5}, wantErr: true},
		{name: "bool rejected", payload: map[string]any{"level": true}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseEventLogLevel(tt.payload)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseEventLogLevel(%v) err = %v, wantErr %v", tt.payload, err, tt.wantErr)
			}
			if err == nil && got != tt.want {
				t.Errorf("parseEventLogLevel(%v) = %d, want %d", tt.payload, got, tt.want)
			}
		})
	}
}

func TestBuildEventLogGetEntryScript(t *testing.T) {
	script := buildEventLogGetEntryScript("System", 9001)
	if !strings.Contains(script, "$_.RecordId -eq 9001") {
		t.Errorf("script missing record filter:\n%s", script)
	}
	if !strings.Contains(script, eventLogTimeCreatedProjection) {
		t.Errorf("script missing TimeCreated ISO projection:\n%s", script)
	}
	if !strings.Contains(script, "UserId, MachineName") {
		t.Errorf("script missing extended properties:\n%s", script)
	}
}

func TestQueryEventLogsXPathValidation(t *testing.T) {
	t.Run("query combined with source is rejected", func(t *testing.T) {
		result := QueryEventLogs(map[string]any{
			"logName": "System",
			"query":   "*[System[Level=2]]",
			"source":  "SomeProvider",
		})
		if result.Status != "failed" {
			t.Fatalf("expected failure, got status %q (stdout=%q)", result.Status, result.Stdout)
		}
		if !strings.Contains(result.Error, "cannot be combined") {
			t.Errorf("error should explain the conflict, got %q", result.Error)
		}
	})

	t.Run("query combined with level is rejected", func(t *testing.T) {
		result := QueryEventLogs(map[string]any{
			"query": "*[System[Level=2]]",
			"level": "error",
		})
		if result.Status != "failed" || !strings.Contains(result.Error, "cannot be combined") {
			t.Fatalf("expected combine-conflict failure, got status=%q error=%q", result.Status, result.Error)
		}
	})

	t.Run("query combined with eventId is rejected", func(t *testing.T) {
		result := QueryEventLogs(map[string]any{
			"query":   "*[System[Level=2]]",
			"eventId": 42,
		})
		if result.Status != "failed" || !strings.Contains(result.Error, "cannot be combined") {
			t.Fatalf("expected combine-conflict failure, got status=%q error=%q", result.Status, result.Error)
		}
	})

	t.Run("oversized query is rejected, not truncated", func(t *testing.T) {
		result := QueryEventLogs(map[string]any{
			"query": strings.Repeat("x", maxEventLogXPathBytes+1),
		})
		if result.Status != "failed" {
			t.Fatalf("expected failure, got status %q", result.Status)
		}
		if !strings.Contains(result.Error, "maximum XPath length") {
			t.Errorf("error should mention the length cap, got %q", result.Error)
		}
	})

	t.Run("non-string query is rejected, not silently dropped", func(t *testing.T) {
		result := QueryEventLogs(map[string]any{
			"query": float64(42),
		})
		if result.Status != "failed" || !strings.Contains(result.Error, "must be a string") {
			t.Fatalf("expected type-rejection failure, got status=%q error=%q", result.Status, result.Error)
		}
	})

	t.Run("unknown level is rejected, not silently dropped", func(t *testing.T) {
		result := QueryEventLogs(map[string]any{
			"level": "sev1",
		})
		if result.Status != "failed" || !strings.Contains(result.Error, "unknown level") {
			t.Fatalf("expected level-rejection failure, got status=%q error=%q", result.Status, result.Error)
		}
	})

	// The acceptance cases below prove validation LETS valid payloads through:
	// on non-Windows they reach the OS layer (platform error), and on any OS
	// the error must never be one of the validation messages.
	assertPassesValidation := func(t *testing.T, payload map[string]any) {
		t.Helper()
		result := QueryEventLogs(payload)
		for _, validationMsg := range []string{"cannot be combined", "maximum XPath length", "must be a string", "unknown level", "out of range"} {
			if strings.Contains(result.Error, validationMsg) {
				t.Fatalf("payload %v was wrongly rejected by validation: %q", payload, result.Error)
			}
		}
	}

	t.Run("valid xpath query alone passes validation", func(t *testing.T) {
		assertPassesValidation(t, map[string]any{
			"logName": "System",
			"query":   "*[System[Provider[@Name='Microsoft-Windows-USB-USBHUB3-Interoperability']]]",
		})
	})

	t.Run("query at exactly the length cap passes validation", func(t *testing.T) {
		assertPassesValidation(t, map[string]any{
			"query": strings.Repeat("x", maxEventLogXPathBytes),
		})
	})

	t.Run("whitespace-only query routes to the legacy path", func(t *testing.T) {
		// Trimmed-empty query must behave as absent: combining it with source
		// is fine, and it must not emit a -FilterXPath ' ' query.
		assertPassesValidation(t, map[string]any{
			"query":  "   ",
			"source": "SomeProvider",
		})
	})

	t.Run("numeric level passes validation", func(t *testing.T) {
		assertPassesValidation(t, map[string]any{
			"level": float64(2),
		})
	})
}

func TestParseEventLogEntriesShapes(t *testing.T) {
	t.Run("empty output yields no entries", func(t *testing.T) {
		for _, output := range []string{"", "\n", "''"} {
			if entries := parseEventLogEntries(output); len(entries) != 0 {
				t.Errorf("parseEventLogEntries(%q) = %d entries, want 0", output, len(entries))
			}
		}
	})

	t.Run("multi-event JSON array yields one entry per event", func(t *testing.T) {
		output := `[
    {
        "RecordId":  1,
        "LogName":  "System",
        "TimeCreated":  "2026-08-03T18:34:56.0000000Z",
        "Id":  10
    },
    {
        "RecordId":  2,
        "LogName":  "System",
        "TimeCreated":  "2026-08-03T18:35:56.0000000Z",
        "Id":  11
    }
]`
		entries := parseEventLogEntries(output)
		if len(entries) != 2 {
			t.Fatalf("expected 2 entries, got %d", len(entries))
		}
		if entries[0].RecordID != 1 || entries[1].RecordID != 2 {
			t.Errorf("record ids = %d, %d; want 1, 2", entries[0].RecordID, entries[1].RecordID)
		}
		for i, e := range entries {
			if e.TimeCreated.IsZero() {
				t.Errorf("entry %d has zero TimeCreated", i)
			}
		}
	})
}
