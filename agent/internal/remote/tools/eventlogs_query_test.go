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
		script := buildEventLogQueryScript("System", "", "", xpath, 0, 100)

		if !strings.Contains(script, "-FilterXPath '*[System[Provider[@Name=''Microsoft-Windows-USB-USBHUB3-Interoperability'']]]'") {
			t.Errorf("script missing escaped -FilterXPath clause:\n%s", script)
		}
		if !strings.Contains(script, "-LogName 'System'") {
			t.Errorf("script missing -LogName clause:\n%s", script)
		}
		if !strings.Contains(script, "-MaxEvents 100") {
			t.Errorf("script missing -MaxEvents clause:\n%s", script)
		}
		if !strings.Contains(script, "-ErrorAction Stop") {
			t.Errorf("xpath script must use -ErrorAction Stop so failures are explicit:\n%s", script)
		}
		if !strings.Contains(script, "NoMatchingEventsFound") {
			t.Errorf("xpath script must treat NoMatchingEventsFound as empty, not an error:\n%s", script)
		}
		if !strings.Contains(script, "exit 1") {
			t.Errorf("xpath script must exit non-zero on query failure:\n%s", script)
		}
		if strings.Contains(script, "-FilterHashtable") {
			t.Errorf("xpath script must not fall back to -FilterHashtable:\n%s", script)
		}
		if !strings.Contains(script, eventLogTimeCreatedProjection) {
			t.Errorf("script missing TimeCreated ISO projection:\n%s", script)
		}
	})

	t.Run("hashtable path keeps legacy filters", func(t *testing.T) {
		script := buildEventLogQueryScript("Application", "error", "MySource", "", 42, 50)

		if !strings.Contains(script, "-FilterHashtable @{LogName='Application' and Level=2 and ProviderName='MySource' and Id=42}") {
			t.Errorf("script missing hashtable filter:\n%s", script)
		}
		if strings.Contains(script, "-FilterXPath") {
			t.Errorf("hashtable script must not contain -FilterXPath:\n%s", script)
		}
		if !strings.Contains(script, "-ErrorAction SilentlyContinue") {
			t.Errorf("hashtable script should keep SilentlyContinue semantics:\n%s", script)
		}
		if !strings.Contains(script, eventLogTimeCreatedProjection) {
			t.Errorf("script missing TimeCreated ISO projection:\n%s", script)
		}
	})

	t.Run("log name single quotes escaped on xpath path", func(t *testing.T) {
		script := buildEventLogQueryScript("O'Brien", "", "", xpath, 0, 10)
		if !strings.Contains(script, "-LogName 'O''Brien'") {
			t.Errorf("log name not escaped:\n%s", script)
		}
	})
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
}
