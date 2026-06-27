package collectors

import (
	"testing"
	"time"
)

func TestNewReliabilityCollectorInitialLookback(t *testing.T) {
	start := time.Now()
	collector := NewReliabilityCollector()
	if collector == nil || collector.eventLogCol == nil {
		t.Fatalf("collector or eventLogCol is nil")
	}

	minExpected := start.Add(-reliabilityInitialLookback - 5*time.Second)
	maxExpected := start.Add(-reliabilityInitialLookback + 5*time.Second)
	actual := collector.eventLogCol.lastCollectTime

	if actual.Before(minExpected) || actual.After(maxExpected) {
		t.Fatalf("unexpected lastCollectTime: got %s expected within [%s, %s]", actual, minExpected, maxExpected)
	}
}

// newMetrics returns an empty ReliabilityMetrics suitable for classifier tests.
func newMetrics() *ReliabilityMetrics {
	return &ReliabilityMetrics{
		CrashEvents:     []CrashEvent{},
		AppHangs:        []AppHang{},
		ServiceFailures: []ServiceFailure{},
		HardwareErrors:  []HardwareError{},
	}
}

// totalFactors sums up how many factor entries exist across all four slices.
func totalFactors(m *ReliabilityMetrics) int {
	return len(m.CrashEvents) + len(m.AppHangs) + len(m.ServiceFailures) + len(m.HardwareErrors)
}

func TestNumericEventID(t *testing.T) {
	tests := []struct {
		name   string
		entry  EventLogEntry
		wantID int
	}{
		{
			name: "Details int takes priority",
			entry: EventLogEntry{
				EventID: "99:12345",
				Details: map[string]any{"eventId": 1001},
			},
			wantID: 1001,
		},
		{
			name: "Details float64 (JSON unmarshal)",
			entry: EventLogEntry{
				EventID: "99:12345",
				Details: map[string]any{"eventId": float64(7031)},
			},
			wantID: 7031,
		},
		{
			name: "Fallback to EventID prefix",
			entry: EventLogEntry{
				EventID: "10010:66601",
				Details: map[string]any{},
			},
			wantID: 10010,
		},
		{
			name: "No colon in EventID",
			entry: EventLogEntry{
				EventID: "41",
				Details: map[string]any{},
			},
			wantID: 41,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := numericEventID(tc.entry)
			if got != tc.wantID {
				t.Errorf("numericEventID = %d, want %d", got, tc.wantID)
			}
		})
	}
}

func TestParseServiceName(t *testing.T) {
	tests := []struct {
		msg      string
		fallback string
		want     string
	}{
		{"The Spooler service terminated unexpectedly.", "Service Control Manager", "Spooler"},
		{"The Windows Update service failed to start.", "Service Control Manager", "Windows Update"},
		{"No match here", "Service Control Manager", "Service Control Manager"},
		{"", "Service Control Manager", "Service Control Manager"},
	}
	for _, tc := range tests {
		got := parseServiceName(tc.msg, tc.fallback)
		if got != tc.want {
			t.Errorf("parseServiceName(%q) = %q, want %q", tc.msg, got, tc.want)
		}
	}
}

func TestClassifyEventLogEntry(t *testing.T) {
	ts := "2026-01-15T10:00:00Z"

	tests := []struct {
		name            string
		entry           EventLogEntry
		wantCrashes     int
		wantServices    int
		wantHangs       int
		wantHardware    int
		wantCrashType   string // optional: check first crash type
		wantServiceName string // optional: check first service name
		wantHWType      string // optional: check first hardware type
	}{
		// ── Bug #1: DCOM 10010 must NOT become a crash ──────────────────────
		{
			name: "DCOM 10010 is dropped (not a crash, service failure, or hardware error)",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Microsoft-Windows-DistributedCOM",
				EventID:   "10010:66601",
				Message:   "The server {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} did not register with DCOM within the required timeout.",
				Details:   map[string]any{"eventId": 10010},
			},
			wantCrashes:  0,
			wantServices: 0,
			wantHangs:    0,
			wantHardware: 0,
		},

		// ── Bug #1 (mirror): real WER 1001 BugCheck IS a crash ─────────────
		{
			name: "WER BugCheck EventID 1001 (source=WER) is a bsod crash",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "application",
				Source:    "Windows Error Reporting",
				EventID:   "1001:55001",
				Message:   "Fault bucket type 5, fault bucket , type 5 Event Name: BlueScreen",
				Details:   map[string]any{"eventId": 1001},
			},
			wantCrashes:   1,
			wantServices:  0,
			wantHardware:  0,
			wantCrashType: "bsod",
		},

		// ── System-log 1001 via Details int, NEUTRAL message → bsod ─────────
		// Neutral message (no "bugcheck"/"bluescreen") so this exercises the
		// `nid==1001 && System-log` branch + the Details["eventId"] int path.
		{
			name: "System-log 1001 (Details int, neutral message) → bsod",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Microsoft-Windows-WER-SystemErrorReporting",
				EventID:   "1001:12",
				Message:   "Fault bucket 1234567890, type 0",
				Details:   map[string]any{"eventId": 1001, "logName": "System"},
			},
			wantCrashes:   1,
			wantCrashType: "bsod",
		},

		// ── System-log 1001 via EventID prefix (no Details eventId) → bsod ──
		{
			name: "System-log 1001 (EventID prefix fallback, neutral message) → bsod",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Microsoft-Windows-WER-SystemErrorReporting",
				EventID:   "1001:999",
				Message:   "Fault bucket report",
				Details:   map[string]any{"logName": "System"}, // no eventId → prefix parse
			},
			wantCrashes:   1,
			wantCrashType: "bsod",
		},

		// ── REGRESSION: Application-log WER 1001 APPCRASH is NOT a crash ─────
		// Ordinary per-app crashes log as "Windows Error Reporting" 1001 in the
		// Application log. Gating the 1001 crash branch on the System log keeps
		// these out of the (heavily-weighted) kernel-crash factor.
		{
			name: "Application-log WER 1001 APPCRASH is NOT a crash",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "application",
				Source:    "Windows Error Reporting",
				EventID:   "1001:42",
				Message:   "Fault bucket 99, type 4 Event Name: APPCRASH Faulting application name: foo.exe",
				Details:   map[string]any{"eventId": 1001, "logName": "Application"},
			},
			wantCrashes:  0,
			wantServices: 0,
			wantHangs:    0,
			wantHardware: 0,
		},

		// ── Kernel-Power 41 → bsod ──────────────────────────────────────────
		{
			name: "Kernel-Power EventID 41 is a bsod crash",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "critical",
				Category:  "system",
				Source:    "Microsoft-Windows-Kernel-Power",
				EventID:   "41:100",
				Message:   "The system has rebooted without cleanly shutting down first.",
				Details:   map[string]any{"eventId": 41},
			},
			wantCrashes:   1,
			wantServices:  0,
			wantHardware:  0,
			wantCrashType: "bsod",
		},

		// ── SCM 7031 → exactly ONE service failure; serviceName parsed ───────
		{
			name: "SCM 7031 Spooler → one service failure, name Spooler, no hardware error",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Service Control Manager",
				EventID:   "7031:200",
				Message:   "The Spooler service terminated unexpectedly. It has done this 1 time(s).",
				Details:   map[string]any{"eventId": 7031},
			},
			wantCrashes:     0,
			wantServices:    1,
			wantHangs:       0,
			wantHardware:    0,
			wantServiceName: "Spooler",
		},

		// ── SCM 7036 (state change) → dropped ───────────────────────────────
		{
			name: "SCM 7036 entered running state is dropped",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "info",
				Category:  "system",
				Source:    "Service Control Manager",
				EventID:   "7036:201",
				Message:   "The Windows Update service entered the running state.",
				Details:   map[string]any{"eventId": 7036},
			},
			wantCrashes:  0,
			wantServices: 0,
			wantHangs:    0,
			wantHardware: 0,
		},

		// ── SCM 7000 (failed to start) → service failure ────────────────────
		{
			name: "SCM 7000 service failed to start",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Service Control Manager",
				EventID:   "7000:300",
				Message:   "The MyService service failed to start due to the following error: The service did not respond.",
				Details:   map[string]any{"eventId": 7000},
			},
			wantCrashes:  0,
			wantServices: 1,
			wantHardware: 0,
		},

		// ── WHEA-Logger → hardware error mce, nothing else ──────────────────
		{
			name: "WHEA-Logger hardware event → one hardware error type mce",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Microsoft-Windows-WHEA-Logger",
				EventID:   "18:500",
				Message:   "A corrected hardware error has occurred. Machine check details: MCE.",
				Details:   map[string]any{"eventId": 18},
			},
			wantCrashes:  0,
			wantServices: 0,
			wantHangs:    0,
			wantHardware: 1,
			wantHWType:   "mce",
		},

		// ── Disk error → hardware error type disk ───────────────────────────
		{
			name: "Disk source → one hardware error type disk",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "disk",
				EventID:   "11:600",
				Message:   "The driver detected a controller error on \\Device\\Harddisk0.",
				Details:   map[string]any{"eventId": 11},
			},
			wantCrashes:  0,
			wantServices: 0,
			wantHangs:    0,
			wantHardware: 1,
			wantHWType:   "disk",
		},

		// ── Application hang 1002 → one hang, nothing else ──────────────────
		{
			name: "Application hang EventID 1002 → one hang",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "application",
				Source:    "Application Hang",
				EventID:   "1002:700",
				Message:   "The program explorer.exe stopped interacting with Windows.",
				Details:   map[string]any{"eventId": 1002},
			},
			wantCrashes:  0,
			wantServices: 0,
			wantHangs:    1,
			wantHardware: 0,
		},

		// ── Category "hardware" alone must NOT cause hardware error ──────────
		{
			name: "System log event with old Category=hardware but benign DCOM source is dropped",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "hardware", // old stale value; classifier must not trust it
				Source:    "Microsoft-Windows-DistributedCOM",
				EventID:   "10010:801",
				Message:   "Some DCOM timeout message",
				Details:   map[string]any{"eventId": 10010},
			},
			wantCrashes:  0,
			wantServices: 0,
			wantHangs:    0,
			wantHardware: 0,
		},

		// ── 6008 unexpected shutdown → bsod ─────────────────────────────────
		{
			name: "EventID 6008 unexpected previous shutdown → bsod",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "warning",
				Category:  "system",
				Source:    "EventLog",
				EventID:   "6008:900",
				Message:   "The previous system shutdown at was unexpected.",
				Details:   map[string]any{"eventId": 6008},
			},
			wantCrashes:   1,
			wantCrashType: "bsod",
		},

		// ── "bugcheck" in message → bsod ────────────────────────────────────
		{
			name: "Message contains bugcheck → bsod",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "critical",
				Category:  "system",
				Source:    "SomeOtherSource",
				EventID:   "999:1",
				Message:   "A bugcheck was triggered: 0x0000007E",
				Details:   map[string]any{"eventId": 999},
			},
			wantCrashes:   1,
			wantCrashType: "bsod",
		},

		// ── kernel panic in message → kernel_panic ───────────────────────────
		{
			name: "Message contains kernel panic → kernel_panic",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "critical",
				Category:  "system",
				Source:    "SomeSource",
				EventID:   "888:1",
				Message:   "Kernel panic - not syncing: VFS: Unable to mount root fs",
				Details:   map[string]any{"eventId": 888},
			},
			wantCrashes:   1,
			wantCrashType: "kernel_panic",
		},

		// ── SCM 7034 → service failure, name parsed ─────────────────────────
		{
			name: "SCM 7034 terminated unexpectedly → service failure, name parsed",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Service Control Manager",
				EventID:   "7034:55",
				Message:   "The Print Spooler service terminated unexpectedly. It has done this 3 time(s).",
				Details:   map[string]any{"eventId": 7034},
			},
			wantServices:    1,
			wantServiceName: "Print Spooler",
		},

		// ── SCM 7022 ("hung on start") → service failure, NOT a hang ─────────
		{
			name: "SCM 7022 hung on start → service failure, not a hang",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Service Control Manager",
				EventID:   "7022:56",
				Message:   "The Foo service hung on starting.",
				Details:   map[string]any{"eventId": 7022},
			},
			wantServices:    1,
			wantHangs:       0,
			wantServiceName: "Foo",
		},

		// ── Non-SCM source w/ service-failure message → service via fallback ─
		{
			name: "Non-SCM source with service-failure message → service failure",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "application",
				Source:    "SomeAppProvider",
				EventID:   "5000:57",
				Message:   "The Backup service terminated unexpectedly.",
				Details:   map[string]any{"eventId": 5000},
			},
			wantServices:    1,
			wantServiceName: "Backup",
		},

		// ── Priority: SCM service event mentioning "disk" stays a service ────
		{
			name: "SCM 7031 whose message mentions disk → service failure, not hardware",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Service Control Manager",
				EventID:   "7031:58",
				Message:   "The DiskBackup service terminated unexpectedly.",
				Details:   map[string]any{"eventId": 7031},
			},
			wantServices:    1,
			wantHardware:    0,
			wantServiceName: "DiskBackup",
		},

		// ── Memory hardware type (classifyHardwareType "memory" branch) ─────
		{
			name: "Memory error → hardware error type memory",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "system",
				Source:    "Microsoft-Windows-Kernel-General",
				EventID:   "13:59",
				Message:   "A memory error was detected by the hardware.",
				Details:   map[string]any{"eventId": 13},
			},
			wantHardware: 1,
			wantHWType:   "memory",
		},

		// ── isHardwareSource-only: known driver, generic message → hardware ─
		{
			name: "Known driver source (nvlddmkm) generic message → hardware error type unknown",
			entry: EventLogEntry{
				Timestamp: ts,
				Level:     "error",
				Category:  "application",
				Source:    "nvlddmkm",
				EventID:   "153:60",
				Message:   "Display driver stopped and has recovered.",
				Details:   map[string]any{"eventId": 153},
			},
			wantHardware: 1,
			wantHWType:   "unknown",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newMetrics()
			classifyEventLogEntry(m, tc.entry)

			// Assert no double-counting: total across all factors must be 0 or 1
			total := totalFactors(m)
			if total > 1 {
				t.Errorf("double-counted: crashes=%d services=%d hangs=%d hardware=%d (total=%d)",
					len(m.CrashEvents), len(m.ServiceFailures), len(m.AppHangs), len(m.HardwareErrors), total)
			}

			if len(m.CrashEvents) != tc.wantCrashes {
				t.Errorf("crashEvents: got %d, want %d", len(m.CrashEvents), tc.wantCrashes)
			}
			if len(m.ServiceFailures) != tc.wantServices {
				t.Errorf("serviceFailures: got %d, want %d", len(m.ServiceFailures), tc.wantServices)
			}
			if len(m.AppHangs) != tc.wantHangs {
				t.Errorf("appHangs: got %d, want %d", len(m.AppHangs), tc.wantHangs)
			}
			if len(m.HardwareErrors) != tc.wantHardware {
				t.Errorf("hardwareErrors: got %d, want %d", len(m.HardwareErrors), tc.wantHardware)
			}

			if tc.wantCrashType != "" && len(m.CrashEvents) > 0 {
				if m.CrashEvents[0].Type != tc.wantCrashType {
					t.Errorf("crashEvents[0].Type = %q, want %q", m.CrashEvents[0].Type, tc.wantCrashType)
				}
			}
			if tc.wantServiceName != "" && len(m.ServiceFailures) > 0 {
				if m.ServiceFailures[0].ServiceName != tc.wantServiceName {
					t.Errorf("serviceFailures[0].ServiceName = %q, want %q", m.ServiceFailures[0].ServiceName, tc.wantServiceName)
				}
			}
			if tc.wantHWType != "" && len(m.HardwareErrors) > 0 {
				if m.HardwareErrors[0].Type != tc.wantHWType {
					t.Errorf("hardwareErrors[0].Type = %q, want %q", m.HardwareErrors[0].Type, tc.wantHWType)
				}
			}
		})
	}
}
