package collectors

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// The API stores events behind a unique index on (device_id, source,
// event_id) with ON CONFLICT DO NOTHING, and event_id is varchar(100)
// (apps/api/src/db/schema/eventLogs.ts). Issue #10731: Linux/macOS ids were
// source+PID, so every later event from a long-running process was dropped.

const apiEventIDMaxLen = 100

func journalLine(t *testing.T, fields map[string]string) string {
	t.Helper()
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal journal line: %v", err)
	}
	return string(b)
}

// Two journal entries from the same process, distinguished only by their
// journald cursor (and message/time), as journalctl --output=json emits them.
func sameProcessJournalLines(t *testing.T, identifier, pid string, extra map[string]string) (string, string) {
	t.Helper()
	base := func(cursor, ts, msg string) map[string]string {
		m := map[string]string{
			"__CURSOR":             cursor,
			"__REALTIME_TIMESTAMP": ts,
			"SYSLOG_IDENTIFIER":    identifier,
			"_PID":                 pid,
			"_BOOT_ID":             "0c4b2f5d6e7a4b8c9d0e1f2a3b4c5d6e",
			"_SYSTEMD_UNIT":        "ssh.service",
		}
		for k, v := range extra {
			m[k] = v
		}
		m["MESSAGE"] = msg
		return m
	}
	a := journalLine(t, base(
		"s=8e1f0b0c2d3e4f5a6b7c8d9e0f1a2b3c;i=1a2b;b=0c4b2f5d6e7a4b8c9d0e1f2a3b4c5d6e;m=3f2a1b;t=5f1e2d3c4b5a6;x=9a8b7c6d5e4f3a2b",
		"1761800000000001", "first message"))
	b := journalLine(t, base(
		"s=8e1f0b0c2d3e4f5a6b7c8d9e0f1a2b3c;i=1a2c;b=0c4b2f5d6e7a4b8c9d0e1f2a3b4c5d6e;m=3f2a9c;t=5f1e2d3c4b5f0;x=1b2c3d4e5f6a7b8c",
		"1761800005000002", "second message"))
	return a, b
}

func assertEventIDContract(t *testing.T, label string, e EventLogEntry) {
	t.Helper()
	if e.EventID == "" {
		t.Fatalf("%s: empty event id", label)
	}
	if n := utf8.RuneCountInString(e.EventID); n > apiEventIDMaxLen {
		t.Fatalf("%s: event id %q is %d chars, exceeds API varchar(%d)", label, e.EventID, n, apiEventIDMaxLen)
	}
	if !utf8.ValidString(e.EventID) {
		t.Fatalf("%s: event id %q is not valid UTF-8", label, e.EventID)
	}
	// reliability.go numericEventID (and the API's numericEventIdPrefix) read
	// the integer before the first ':' as a Windows event id; a Linux/macOS id
	// must never parse as one or it would be classified as e.g. a 41/6008.
	if got := numericEventID(e); got != 0 {
		t.Fatalf("%s: event id %q parses as numeric Windows event id %d", label, e.EventID, got)
	}
}

func TestJournalEventIDsDistinctPerEntryFromSameProcess(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		identifier string
		extra      map[string]string
		convert    func([]journalEntry) []EventLogEntry
	}{
		{"security/sshd", "sshd", map[string]string{"PRIORITY": "4"}, journalSecurityEvents},
		{"hardware/kernel", "kernel", map[string]string{"PRIORITY": "3"}, journalKernelEvents},
		{"application/systemd", "systemd", map[string]string{"PRIORITY": "3"}, journalServiceFailureEvents},
		// journalSystemEvents keeps only lifecycle messages.
		{"system/systemd", "systemd", map[string]string{"PRIORITY": "6"}, func(entries []journalEntry) []EventLogEntry {
			for i := range entries {
				entries[i].Message = "Started " + entries[i].Message
			}
			return journalSystemEvents(entries)
		}},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			a, b := sameProcessJournalLines(t, tc.identifier, "812", tc.extra)

			events := tc.convert(parseJournalJSONLines([]byte(a + "\n" + b + "\n")))
			if len(events) != 2 {
				t.Fatalf("expected 2 events, got %d", len(events))
			}
			for _, e := range events {
				assertEventIDContract(t, tc.name, e)
			}
			if events[0].Source != events[1].Source {
				t.Fatalf("test setup: sources differ (%q vs %q)", events[0].Source, events[1].Source)
			}
			if events[0].EventID == events[1].EventID {
				t.Fatalf("two entries from PID 812 share event id %q; the API dedup index drops the second", events[0].EventID)
			}

			// Re-collecting the same entry (overlapping --since windows, retry
			// passes) must yield the same id so the dedup index absorbs it.
			again := tc.convert(parseJournalJSONLines([]byte(a + "\n")))
			if len(again) != 1 || again[0].EventID != events[0].EventID {
				t.Fatalf("re-collected entry id changed: first %q, again %+v", events[0].EventID, again)
			}
		})
	}
}

func TestJournalEventIDBoundedForLongIdentifier(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("ä", 300) // multi-byte, forces a rune-safe cut
	a, b := sameProcessJournalLines(t, long, "812", map[string]string{"PRIORITY": "3"})
	events := journalServiceFailureEvents(parseJournalJSONLines([]byte(a + "\n" + b + "\n")))
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	for _, e := range events {
		assertEventIDContract(t, "long identifier", e)
	}
	if events[0].EventID == events[1].EventID {
		t.Fatalf("bounded ids collided: %q", events[0].EventID)
	}
}

// Two `log show --style json` entries from the same process and subsystem,
// distinguished by their mach timestamp / thread / trace id.
const sameProcessUnifiedLog = `[
  {"timestamp":"2026-10-30 10:15:01.123456-0700","machTimestamp":81234567890123,"traceID":4096221185,"threadID":901234,
   "bootUUID":"6F2B6B2E-3A4C-4D5E-8F90-1A2B3C4D5E6F","subsystem":"com.apple.opendirectoryd","category":"auth",
   "eventMessage":"Authentication failed for user admin","messageType":"Error","processImagePath":"/usr/libexec/opendirectoryd","processID":312},
  {"timestamp":"2026-10-30 10:15:07.654321-0700","machTimestamp":81234712345678,"traceID":4096221443,"threadID":901240,
   "bootUUID":"6F2B6B2E-3A4C-4D5E-8F90-1A2B3C4D5E6F","subsystem":"com.apple.opendirectoryd","category":"auth",
   "eventMessage":"Authentication failed for user admin","messageType":"Error","processImagePath":"/usr/libexec/opendirectoryd","processID":312}
]`

func parseUnifiedLog(t *testing.T, raw string) []unifiedLogEntry {
	t.Helper()
	var entries []unifiedLogEntry
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		t.Fatalf("unmarshal unified log: %v", err)
	}
	return entries
}

func TestUnifiedLogEventIDsDistinctPerEntryFromSameProcess(t *testing.T) {
	t.Parallel()
	entries := parseUnifiedLog(t, sameProcessUnifiedLog)

	events := unifiedLogEvents(entries, true, true)
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	for _, e := range events {
		assertEventIDContract(t, "unified log", e)
	}
	// Identical message on purpose: repeated auth failures from one process.
	if events[0].EventID == events[1].EventID {
		t.Fatalf("two entries from PID 312 share event id %q; the API dedup index drops the second", events[0].EventID)
	}

	again := unifiedLogEvents(parseUnifiedLog(t, sameProcessUnifiedLog), true, true)
	if again[0].EventID != events[0].EventID || again[1].EventID != events[1].EventID {
		t.Fatalf("re-collected ids changed: %q/%q vs %q/%q",
			events[0].EventID, events[1].EventID, again[0].EventID, again[1].EventID)
	}
}

func TestUnifiedLogEventIDBoundedForLongSubsystem(t *testing.T) {
	t.Parallel()
	entries := parseUnifiedLog(t, sameProcessUnifiedLog)
	for i := range entries {
		entries[i].Subsystem = "com.example." + strings.Repeat("ü", 200)
	}
	events := unifiedLogEvents(entries, true, true)
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	for _, e := range events {
		assertEventIDContract(t, "long subsystem", e)
	}
	if events[0].EventID == events[1].EventID {
		t.Fatalf("bounded ids collided: %q", events[0].EventID)
	}
}

// Unexpected JSON types for the identity fields must not fail the whole
// `log show` parse (that would drop every security/hardware event).
func TestUnifiedLogEntryToleratesIdentityFieldTypes(t *testing.T) {
	t.Parallel()
	raw := `[{"timestamp":"2026-10-30 10:15:01.123456-0700","machTimestamp":"81234567890123","traceID":null,
	  "threadID":1.5,"bootUUID":"x","subsystem":"com.apple.TCC","eventMessage":"denied","messageType":"Fault","processID":7}]`
	events := unifiedLogEvents(parseUnifiedLog(t, raw), true, true)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	assertEventIDContract(t, "odd types", events[0])
}

func TestCrashReportEventID(t *testing.T) {
	t.Parallel()
	// Short names keep the pre-#10731 shape, so rows already stored still
	// dedupe against a re-scan after the agent upgrade.
	name := "Safari-2026-10-30-101501.ips"
	if got := crashReportEventID(name); got != "crash:"+name {
		t.Fatalf("crashReportEventID(%q) = %q, want unchanged crash:<file>", name, got)
	}

	longA := strings.Repeat("com.example.VeryLongHelperProcessName", 4) + "-2026-10-30-101501.ips"
	longB := strings.Repeat("com.example.VeryLongHelperProcessName", 4) + "-2026-10-30-101502.ips"
	a, b := crashReportEventID(longA), crashReportEventID(longB)
	for _, id := range []string{a, b} {
		assertEventIDContract(t, "crash", EventLogEntry{EventID: id})
	}
	if a == b {
		t.Fatalf("long crash report names sharing a prefix collided: %q", a)
	}
	if a != crashReportEventID(longA) {
		t.Fatal("crashReportEventID is not deterministic")
	}
}

// Golden values: ids of entries already stored must not change across agent
// releases, or every stored Linux/macOS event re-inserts as a duplicate after
// an upgrade. A change to the hash, separator, part order or field set must
// fail here and be made deliberately.
func TestEventLogIDGoldenValues(t *testing.T) {
	t.Parallel()
	if eventLogIDHash("ab", "c") == eventLogIDHash("a", "bc") {
		t.Fatal("hash parts must be separated")
	}

	journal := journalEntry{
		Cursor:            "s=8e1f0b0c2d3e4f5a6b7c8d9e0f1a2b3c;i=1a2b;b=0c4b2f5d6e7a4b8c9d0e1f2a3b4c5d6e;m=3f2a1b;t=5f1e2d3c4b5a6;x=9a8b7c6d5e4f3a2b",
		SyslogIdentifier:  "sshd",
		PID:               "812",
		RealtimeTimestamp: "1761800000000001",
		Message:           "first message",
	}
	unified := parseUnifiedLog(t, sameProcessUnifiedLog)[0]

	cases := []struct{ name, got, want string }{
		{"hash", eventLogIDHash("a", "b"), "8fb20ef63ced4145"},
		{"journal", journalEntryEventID("sshd:812", journal), "sshd:812:5d686e67c3b95e9c"},
		{"unified", unifiedLogEntryEventID("com.apple.opendirectoryd:312", unified), "com.apple.opendirectoryd:312:16c454ac7a05fd97"},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s id = %q, want %q", tc.name, tc.got, tc.want)
		}
	}
}

func TestJournalEventIDWithoutCursor(t *testing.T) {
	t.Parallel()
	base := journalEntry{SyslogIdentifier: "sshd", PID: "812", BootID: "b1", RealtimeTimestamp: "1761800000000001", Message: "m"}
	later := base
	later.RealtimeTimestamp = "1761800000000002"
	withCursor := base
	withCursor.Cursor = "s=1;i=2"

	a, b := journalEntryEventID("sshd:812", base), journalEntryEventID("sshd:812", later)
	if a == b {
		t.Fatalf("cursor-less entries at different times share id %q", a)
	}
	if a != journalEntryEventID("sshd:812", base) {
		t.Fatal("cursor-less id is not stable")
	}
	if a == journalEntryEventID("sshd:812", withCursor) {
		t.Fatal("cursor-less id must differ from the cursor-keyed id")
	}
}

func TestUnifiedLogEventIDKeying(t *testing.T) {
	t.Parallel()
	entry := func() unifiedLogEntry { return parseUnifiedLog(t, sameProcessUnifiedLog)[0] }
	head := "com.apple.opendirectoryd:312"
	ref := unifiedLogEntryEventID(head, entry())

	// The wall-clock string is rendered in the local zone; with a mach
	// timestamp present a zone change must not change the id.
	tz := entry()
	tz.Timestamp = "2026-10-30 18:15:01.123456+0100"
	if got := unifiedLogEntryEventID(head, tz); got != ref {
		t.Fatalf("zone change altered the id: %q vs %q", got, ref)
	}

	// Same mach tick on another thread is another entry.
	thread := entry()
	thread.ThreadID = []byte("901235")
	if unifiedLogEntryEventID(head, thread) == ref {
		t.Fatal("entries on different threads share an id")
	}

	// Without a mach timestamp the wall-clock time keys the entry.
	noMach := entry()
	noMach.MachTimestamp = nil
	noMachLater := entry()
	noMachLater.MachTimestamp = []byte("null")
	noMachLater.Timestamp = "2026-10-30 10:15:02.000001-0700"
	if unifiedLogEntryEventID(head, noMach) == unifiedLogEntryEventID(head, noMachLater) {
		t.Fatal("mach-less entries at different times share an id")
	}
}

func TestEventIDStripsControlCharacters(t *testing.T) {
	t.Parallel()
	entries := parseUnifiedLog(t, sameProcessUnifiedLog)
	entries[0].Subsystem = "com.apple.\x00opendirectoryd"
	events := unifiedLogEvents(entries[:1], true, true)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if strings.ContainsRune(events[0].EventID, 0) {
		t.Fatalf("event id %q carries NUL; Postgres rejects the whole insert batch", events[0].EventID)
	}
	assertEventIDContract(t, "NUL subsystem", events[0])
}

func TestBoundEventID(t *testing.T) {
	t.Parallel()
	exact := strings.Repeat("a", apiEventIDMaxLen)
	if got := boundEventID(exact); got != exact {
		t.Fatalf("an id at the limit must be unchanged, got %q", got)
	}
	over := exact + "b"
	if got := boundEventID(over); utf8.RuneCountInString(got) != apiEventIDMaxLen || got == exact {
		t.Fatalf("an id over the limit must be cut to the limit and differ from its prefix, got %q", got)
	}
	invalid := "src\xff\xfe:812"
	got := boundEventID(invalid)
	if !utf8.ValidString(got) {
		t.Fatalf("invalid UTF-8 must be repaired, got %q", got)
	}
	if got == boundEventID("src:812") {
		t.Fatal("repairing invalid UTF-8 must not collide with the clean id")
	}
}
