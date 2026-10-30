package collectors

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	perQueryCap        = 50
	eventLogMaxBacklog = 24 * time.Hour
	winEventTimeFormat = "2006-01-02T15:04:05.0000000Z"
	// StandardEventKeywords.AuditFailure; Security records also set channel bit 63.
	auditFailureKeyword uint64 = 0x10000000000000
)

// securityAuditEventIDs covers actionable Audit Success events. Failed logon
// 4625 is already covered by the Audit Failure keyword. Deliberately exclude
// 4672: every SYSTEM/service/admin logon emits it, exhausting the stream budget.
// A follow-up could include it with a SubjectUserSid filter.
var securityAuditEventIDs = []int{
	1102, // Audit log cleared.
	4719, // System audit policy changed.
	4720, // User account created.
	4726, // User account deleted.
	4728, // Member added to a security-enabled global group.
	4732, // Member added to a security-enabled local group.
	4740, // Account locked out.
	4756, // Member added to a security-enabled universal group.
}

func securityEventSelection() string {
	parts := []string{"Level=1", "Level=2", "Level=3", fmt.Sprintf("band(Keywords,%d)", auditFailureKeyword)}
	for _, id := range securityAuditEventIDs {
		parts = append(parts, fmt.Sprintf("EventID=%d", id))
	}
	return "(" + strings.Join(parts, " or ") + ")"
}

func powerEventSelection() string {
	parts := make([]string, 0, len(windowsPowerEventIDs))
	for _, id := range windowsPowerEventIDs {
		parts = append(parts, fmt.Sprintf("EventID=%d", id))
	}
	return "(" + strings.Join(parts, " or ") + ")"
}

func applicationProviderSelection(providers []string) string {
	parts := make([]string, 0, len(providers))
	for _, provider := range providers {
		if !validApplicationProviderName(provider) {
			continue
		}
		parts = append(parts, "@Name='"+provider+"'")
	}
	if len(parts) == 0 {
		return "(Level=3 and Level=4)" // No safe providers: match nothing.
	}
	return "Provider[" + strings.Join(parts, " or ") + "] and (Level=3 or Level=4)"
}

func buildWinEventXPath(selection string, bookmark *eventLogBookmark, seed, now time.Time) (string, bool) {
	since := seed
	allowFloor := true
	clause := "TimeCreated[@SystemTime>='" + seed.UTC().Format(winEventTimeFormat) + "']"
	if bookmark != nil {
		since = bookmark.Time
		switch {
		case bookmark.RecordID == 0:
			clause = "TimeCreated[@SystemTime>='" + bookmark.Time.UTC().Format(winEventTimeFormat) + "']"
		case bookmark.RecordID > 0 && bookmark.Time.IsZero():
			clause = fmt.Sprintf("EventRecordID>%d", bookmark.RecordID)
			allowFloor = false // No trustworthy timestamp for a time-based floor.
		default:
			clause = fmt.Sprintf("(EventRecordID>%d or TimeCreated[@SystemTime>'%s'])", bookmark.RecordID, bookmark.Time.UTC().Format(winEventTimeFormat))
		}
	}
	floor := now.Add(-eventLogMaxBacklog)
	floorApplied := allowFloor && since.Before(floor)
	if floorApplied {
		clause += " and TimeCreated[@SystemTime>='" + floor.UTC().Format(winEventTimeFormat) + "']"
	}
	return "*[System[" + clause + " and " + selection + "]]", floorApplied
}

func psSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func buildWinEventCommand(logName, xpath string) string {
	return fmt.Sprintf(`try { $ev = @(Get-WinEvent -LogName %s -FilterXPath %s -Oldest -MaxEvents %d -ErrorAction SilentlyContinue -ErrorVariable gwe) } `+
		`catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }; `+
		`$errs = @($gwe | Where-Object { $_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*' }); `+
		`if ($ev.Count -eq 0 -and $errs.Count -gt 0) { [Console]::Error.WriteLine($errs[0].Exception.Message); exit 3 }; `+
		`if ($errs.Count -gt 0) { [Console]::Error.WriteLine($errs[0].Exception.Message) }; `+
		`$ev | Select-Object RecordId, LogName, Level, Keywords, @{N='TimeCreated';E={$_.TimeCreated.ToString('o')}}, @{N='TimeCreatedUtc';E={$_.TimeCreated.ToUniversalTime().ToString('o')}}, ProviderName, Id, Message, @{N='InsertionText';E={ if ([string]::IsNullOrWhiteSpace($_.Message)) { ($_.Properties.Value -join ' ') } else { $null } }} | ConvertTo-Json -Depth 2 -Compress; exit 0`,
		psSingleQuote(logName), psSingleQuote(xpath), perQueryCap)
}

// winEventQueryOutput never accepts partial output from a failed command.
// The stream pipeline adds the stable stream key to the returned error.
func winEventQueryOutput(output []byte, runErr error) ([]winEvent, error) {
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			return nil, fmt.Errorf("Get-WinEvent failed: %w (stderr: %s)", runErr, truncateCollectorString(strings.TrimSpace(string(exitErr.Stderr))))
		}
		return nil, fmt.Errorf("Get-WinEvent failed: %w", runErr)
	}
	return parseWinEventJSON(output)
}

// winEvent represents the PowerShell JSON projection, including signed Keywords.
// Convert to uint64 before testing keyword flags (the Security channel sets bit 63).
type winEvent struct {
	RecordId       int64  `json:"RecordId"`
	LogName        string `json:"LogName"`
	Level          int    `json:"Level"`
	Keywords       int64  `json:"Keywords"`
	TimeCreated    string `json:"TimeCreated"`
	TimeCreatedUtc string `json:"TimeCreatedUtc"`
	ProviderName   string `json:"ProviderName"`
	Id             int    `json:"Id"`
	Message        string `json:"Message"`
	InsertionText  string `json:"InsertionText"`
}

func parseWinEventJSON(data []byte) ([]winEvent, error) {
	raw := data
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return nil, nil
	}
	var events []winEvent
	switch data[0] {
	case '[':
		if err := json.Unmarshal(data, &events); err != nil {
			return nil, winEventParseError(raw, err)
		}
	case '{':
		var event winEvent
		if err := json.Unmarshal(data, &event); err != nil {
			return nil, winEventParseError(raw, err)
		}
		events = []winEvent{event}
	default:
		return nil, winEventParseError(raw, errors.New("expected JSON array or object"))
	}
	return sanitizeWinEvents(events), nil
}

func winEventParseError(data []byte, err error) error {
	if len(data) > 120 {
		data = data[:120]
	}
	return fmt.Errorf("parse Windows events: %w (output prefix: %q)", err, data)
}

func sanitizeWinEvents(events []winEvent) []winEvent {
	if len(events) > collectorResultLimit {
		events = events[:collectorResultLimit]
	}
	for i := range events {
		events[i].LogName = truncateCollectorString(events[i].LogName)
		events[i].TimeCreated = truncateCollectorString(events[i].TimeCreated)
		events[i].TimeCreatedUtc = truncateCollectorString(events[i].TimeCreatedUtc)
		events[i].ProviderName = truncateCollectorString(events[i].ProviderName)
		events[i].Message = truncateString(strings.TrimSpace(events[i].Message), 500)
		events[i].InsertionText = truncateString(strings.TrimSpace(events[i].InsertionText), 500)
	}
	return events
}

func winEventMessage(e winEvent) string {
	message := strings.TrimSpace(e.Message)
	if message == "" {
		message = strings.TrimSpace(e.InsertionText)
	}
	if message == "" {
		message = fmt.Sprintf("(no message text: provider %s, event ID %d)", e.ProviderName, e.Id)
	}
	return truncateString(message, 500)
}

func mapSecurityEventLevel(level int, keywords int64, eventID int) string {
	if level >= 1 && level <= 3 {
		return mapWinLevel(level)
	}
	if uint64(keywords)&auditFailureKeyword != 0 {
		return "warning"
	}
	for _, id := range securityAuditEventIDs {
		if eventID == id {
			return "warning"
		}
	}
	return mapWinLevel(level)
}

// mapWinLevel maps Windows Event Log numeric level to our level enum
func mapWinLevel(level int) string {
	switch level {
	case 1:
		return "critical"
	case 2:
		return "error"
	case 3:
		return "warning"
	case 4, 5:
		return "info"
	default:
		return "info"
	}
}

// mapPowerEventLevel returns the severity level for known power Event IDs
func mapPowerEventLevel(eventID int) string {
	switch eventID {
	case 41: // Kernel-Power: unexpected shutdown (bugcheck)
		return "critical"
	case 6008: // Unexpected shutdown (previous boot)
		return "warning"
	case 1074: // User32: planned restart/shutdown
		return "info"
	case 6005: // EventLog service started (boot)
		return "info"
	case 6006: // EventLog service stopped (clean shutdown)
		return "info"
	case 6009: // OS version info at boot
		return "info"
	default:
		return "info"
	}
}

// mapPowerEventType returns a human-readable type string for known power Event IDs
func mapPowerEventType(eventID int) string {
	switch eventID {
	case 41:
		return "unexpected_shutdown"
	case 1074:
		return "planned_shutdown"
	case 6005:
		return "boot"
	case 6006:
		return "clean_shutdown"
	case 6008:
		return "unexpected_shutdown"
	case 6009:
		return "boot_info"
	default:
		return "power"
	}
}
