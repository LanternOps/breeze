//go:build windows

package tools

import (
	"fmt"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modWevtapi = windows.NewLazySystemDLL("wevtapi.dll")

	// Event Log API functions
	procEvtOpenLog             = modWevtapi.NewProc("EvtOpenLog")
	procEvtClose               = modWevtapi.NewProc("EvtClose")
	procEvtGetLogInfo          = modWevtapi.NewProc("EvtGetLogInfo")
	procEvtQuery               = modWevtapi.NewProc("EvtQuery")
	procEvtNext                = modWevtapi.NewProc("EvtNext")
	procEvtRender              = modWevtapi.NewProc("EvtRender")
	procEvtCreateRenderContext = modWevtapi.NewProc("EvtCreateRenderContext")
	procEvtClearLog            = modWevtapi.NewProc("EvtClearLog")
	procEvtOpenChannelEnum     = modWevtapi.NewProc("EvtOpenChannelEnum")
	procEvtNextChannelPath     = modWevtapi.NewProc("EvtNextChannelPath")
	procEvtSeek                = modWevtapi.NewProc("EvtSeek")
)

// Windows Event Log constants
const (
	EvtQueryChannelPath         = 0x1
	EvtQueryFilePath            = 0x2
	EvtQueryForwardDirection    = 0x100
	EvtQueryReverseDirection    = 0x200
	EvtQueryTolerateQueryErrors = 0x1000

	EvtRenderEventValues = 0
	EvtRenderEventXml    = 1
	EvtRenderBookmark    = 2

	EvtSeekRelativeToFirst    = 1
	EvtSeekRelativeToLast     = 2
	EvtSeekRelativeToCurrent  = 3
	EvtSeekRelativeToBookmark = 4
	EvtSeekOriginMask         = 7
	EvtSeekStrict             = 0x10000

	// Log info property IDs
	EvtLogCreationTime       = 0
	EvtLogLastAccessTime     = 1
	EvtLogLastWriteTime      = 2
	EvtLogFileSize           = 3
	EvtLogAttributes         = 4
	EvtLogNumberOfLogRecords = 5
	EvtLogOldestRecordNumber = 6
	EvtLogFull               = 7

	// Event level values
	EvtLevelCritical    = 1
	EvtLevelError       = 2
	EvtLevelWarning     = 3
	EvtLevelInformation = 4
	EvtLevelVerbose     = 5
)

// EvtVariant represents a Windows EVT_VARIANT structure
type EvtVariant struct {
	Value [16]byte
	Count uint32
	Type  uint32
}

// ListLogs returns a list of available event logs on the system.
func (m *EventLogManager) ListLogs() ([]EventLog, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var logs []EventLog

	// Open channel enumeration
	hEnum, _, err := procEvtOpenChannelEnum.Call(0, 0)
	if hEnum == 0 {
		return nil, fmt.Errorf("failed to open channel enumeration: %w", err)
	}
	defer procEvtClose.Call(hEnum)

	// Buffer for channel names
	bufSize := uint32(512)
	buf := make([]uint16, bufSize)

	for {
		var used uint32
		ret, _, _ := procEvtNextChannelPath.Call(
			hEnum,
			uintptr(bufSize),
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(unsafe.Pointer(&used)),
		)
		if ret == 0 {
			// Check if we need a larger buffer or if we're done
			if used > bufSize {
				bufSize = used
				buf = make([]uint16, bufSize)
				continue
			}
			break
		}

		channelName := windows.UTF16ToString(buf[:used])

		// Only include main logs by default (filter out verbose operational logs)
		if isMainLog(channelName) {
			info, err := m.GetLogInfo(channelName)
			if err == nil {
				logs = append(logs, *info)
			}
		}
	}

	return logs, nil
}

// isMainLog returns true if the log is one of the main event logs
func isMainLog(name string) bool {
	mainLogs := []string{
		"Application",
		"Security",
		"Setup",
		"System",
		"ForwardedEvents",
		"Microsoft-Windows-PowerShell/Operational",
		"Microsoft-Windows-Sysmon/Operational",
		"Microsoft-Windows-TaskScheduler/Operational",
		"Microsoft-Windows-Windows Defender/Operational",
		"Microsoft-Windows-WMI-Activity/Operational",
	}

	for _, main := range mainLogs {
		if strings.EqualFold(name, main) {
			return true
		}
	}
	return false
}

// GetLogInfo retrieves metadata about a specific event log.
func (m *EventLogManager) GetLogInfo(logName string) (*EventLog, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	logNamePtr, err := windows.UTF16PtrFromString(logName)
	if err != nil {
		return nil, fmt.Errorf("invalid log name: %w", err)
	}

	// Open the log
	hLog, _, err := procEvtOpenLog.Call(
		0,
		uintptr(unsafe.Pointer(logNamePtr)),
		EvtQueryChannelPath,
	)
	if hLog == 0 {
		return nil, fmt.Errorf("failed to open log '%s': %w", logName, err)
	}
	defer procEvtClose.Call(hLog)

	log := &EventLog{
		Name:        logName,
		DisplayName: getDisplayName(logName),
	}

	// Get record count
	recordCount, err := getLogPropertyUint64(hLog, EvtLogNumberOfLogRecords)
	if err == nil {
		log.RecordCount = recordCount
	}

	// Get file size
	fileSize, err := getLogPropertyUint64(hLog, EvtLogFileSize)
	if err == nil {
		log.MaxSizeBytes = fileSize
	}

	// Determine retention policy (simplified)
	isFull, _ := getLogPropertyBool(hLog, EvtLogFull)
	if isFull {
		log.Retention = "Full"
	} else {
		log.Retention = "Overwrite"
	}

	return log, nil
}

func getLogPropertyUint64(hLog uintptr, propertyId int) (uint64, error) {
	var variant EvtVariant
	var needed uint32

	ret, _, err := procEvtGetLogInfo.Call(
		hLog,
		uintptr(propertyId),
		uintptr(unsafe.Sizeof(variant)),
		uintptr(unsafe.Pointer(&variant)),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ret == 0 {
		return 0, err
	}

	return *(*uint64)(unsafe.Pointer(&variant.Value[0])), nil
}

func getLogPropertyBool(hLog uintptr, propertyId int) (bool, error) {
	var variant EvtVariant
	var needed uint32

	ret, _, err := procEvtGetLogInfo.Call(
		hLog,
		uintptr(propertyId),
		uintptr(unsafe.Sizeof(variant)),
		uintptr(unsafe.Pointer(&variant)),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ret == 0 {
		return false, err
	}

	return variant.Value[0] != 0, nil
}

func getDisplayName(logName string) string {
	// Map common log names to display names
	displayNames := map[string]string{
		"Application":     "Application",
		"Security":        "Security",
		"Setup":           "Setup",
		"System":          "System",
		"ForwardedEvents": "Forwarded Events",
	}

	if display, ok := displayNames[logName]; ok {
		return display
	}

	// For provider-based logs, extract a friendly name
	parts := strings.Split(logName, "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return logName
}

// QueryEvents queries events from a log with the specified filter.
func (m *EventLogManager) QueryEvents(logName string, filter EventFilter) (*EventQueryResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Set defaults
	limit := filter.Limit
	if limit <= 0 {
		limit = DefaultQueryLimit
	}
	if limit > MaxQueryLimit {
		limit = MaxQueryLimit
	}

	// Build XPath query
	query := buildXPathQuery(filter)

	logNamePtr, err := windows.UTF16PtrFromString(logName)
	if err != nil {
		return nil, fmt.Errorf("invalid log name: %w", err)
	}

	queryPtr, err := windows.UTF16PtrFromString(query)
	if err != nil {
		return nil, fmt.Errorf("invalid query: %w", err)
	}

	// Open query
	hQuery, _, err := procEvtQuery.Call(
		0,
		uintptr(unsafe.Pointer(logNamePtr)),
		uintptr(unsafe.Pointer(queryPtr)),
		EvtQueryChannelPath|EvtQueryReverseDirection,
	)
	if hQuery == 0 {
		return nil, fmt.Errorf("failed to query log '%s': %w", logName, err)
	}
	defer procEvtClose.Call(hQuery)

	// Handle offset (pagination)
	if filter.Offset > 0 {
		ret, _, _ := procEvtSeek.Call(
			hQuery,
			uintptr(filter.Offset),
			0,
			0,
			EvtSeekRelativeToFirst,
		)
		if ret == 0 {
			// If seek fails, we may have fewer records than offset
			return &EventQueryResult{
				Events:     []EventLogEntry{},
				TotalCount: 0,
				HasMore:    false,
				Offset:     filter.Offset,
				Limit:      limit,
			}, nil
		}
	}

	// Create render context for system values
	hContext, _, _ := procEvtCreateRenderContext.Call(0, 0, 1) // EvtRenderContextSystem
	if hContext != 0 {
		defer procEvtClose.Call(hContext)
	}

	// Fetch events
	var events []EventLogEntry
	eventHandles := make([]uintptr, limit+1) // Fetch one extra to check if there are more
	var returned uint32

	ret, _, _ := procEvtNext.Call(
		hQuery,
		uintptr(len(eventHandles)),
		uintptr(unsafe.Pointer(&eventHandles[0])),
		0,
		0,
		uintptr(unsafe.Pointer(&returned)),
	)

	if ret == 0 && returned == 0 {
		return &EventQueryResult{
			Events:     []EventLogEntry{},
			TotalCount: 0,
			HasMore:    false,
			Offset:     filter.Offset,
			Limit:      limit,
		}, nil
	}

	hasMore := int(returned) > limit
	if hasMore {
		returned = uint32(limit)
	}

	for i := uint32(0); i < returned; i++ {
		if eventHandles[i] == 0 {
			continue
		}

		entry, err := renderEvent(eventHandles[i])
		if err == nil {
			events = append(events, *entry)
		}
		procEvtClose.Call(eventHandles[i])
	}

	// Close any extra handles
	for i := returned; i < uint32(len(eventHandles)); i++ {
		if eventHandles[i] != 0 {
			procEvtClose.Call(eventHandles[i])
		}
	}

	return &EventQueryResult{
		Events:     events,
		TotalCount: len(events),
		HasMore:    hasMore,
		Offset:     filter.Offset,
		Limit:      limit,
	}, nil
}

func buildXPathQuery(filter EventFilter) string {
	var conditions []string

	// Level filter
	if len(filter.Level) > 0 {
		var levelConditions []string
		for _, level := range filter.Level {
			switch strings.ToLower(level) {
			case "critical":
				levelConditions = append(levelConditions, "Level=1")
			case "error":
				levelConditions = append(levelConditions, "Level=2")
			case "warning":
				levelConditions = append(levelConditions, "Level=3")
			case "information", "info":
				levelConditions = append(levelConditions, "Level=4")
			case "verbose":
				levelConditions = append(levelConditions, "Level=5")
			}
		}
		if len(levelConditions) > 0 {
			conditions = append(conditions, "("+strings.Join(levelConditions, " or ")+")")
		}
	}

	// Event ID filter
	if len(filter.EventIDs) > 0 {
		var idConditions []string
		for _, id := range filter.EventIDs {
			idConditions = append(idConditions, fmt.Sprintf("EventID=%d", id))
		}
		conditions = append(conditions, "("+strings.Join(idConditions, " or ")+")")
	}

	// Source/Provider filter
	if filter.Source != "" {
		conditions = append(conditions, fmt.Sprintf("Provider[@Name='%s']", filter.Source))
	}

	// Time range filter
	if !filter.StartTime.IsZero() {
		conditions = append(conditions, fmt.Sprintf("TimeCreated[@SystemTime>='%s']",
			filter.StartTime.UTC().Format("2006-01-02T15:04:05.000Z")))
	}
	if !filter.EndTime.IsZero() {
		conditions = append(conditions, fmt.Sprintf("TimeCreated[@SystemTime<='%s']",
			filter.EndTime.UTC().Format("2006-01-02T15:04:05.000Z")))
	}

	if len(conditions) == 0 {
		return "*"
	}

	return "*[System[" + strings.Join(conditions, " and ") + "]]"
}

func renderEvent(hEvent uintptr) (*EventLogEntry, error) {
	// First call to get required buffer size
	var bufSize uint32
	var propCount uint32

	procEvtRender.Call(
		0,
		hEvent,
		EvtRenderEventXml,
		0,
		0,
		uintptr(unsafe.Pointer(&bufSize)),
		uintptr(unsafe.Pointer(&propCount)),
	)

	if bufSize == 0 {
		bufSize = 65536 // Default buffer size
	}

	buf := make([]uint16, bufSize/2)
	ret, _, err := procEvtRender.Call(
		0,
		hEvent,
		EvtRenderEventXml,
		uintptr(bufSize),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&bufSize)),
		uintptr(unsafe.Pointer(&propCount)),
	)

	if ret == 0 {
		return nil, fmt.Errorf("failed to render event: %w", err)
	}

	xmlStr := windows.UTF16ToString(buf)
	return parseEventXml(xmlStr)
}

func parseEventXml(xml string) (*EventLogEntry, error) {
	entry := &EventLogEntry{}

	// Parse RecordID
	if idx := strings.Index(xml, "<EventRecordID>"); idx != -1 {
		end := strings.Index(xml[idx:], "</EventRecordID>")
		if end != -1 {
			value := xml[idx+15 : idx+end]
			fmt.Sscanf(value, "%d", &entry.RecordID)
		}
	}

	// Parse EventID
	if idx := strings.Index(xml, "<EventID"); idx != -1 {
		start := strings.Index(xml[idx:], ">")
		end := strings.Index(xml[idx:], "</EventID>")
		if start != -1 && end != -1 {
			value := xml[idx+start+1 : idx+end]
			fmt.Sscanf(value, "%d", &entry.EventID)
		}
	}

	// Parse Level
	if idx := strings.Index(xml, "<Level>"); idx != -1 {
		end := strings.Index(xml[idx:], "</Level>")
		if end != -1 {
			value := xml[idx+7 : idx+end]
			var level int
			fmt.Sscanf(value, "%d", &level)
			entry.Level = levelToString(level)
		}
	}

	// Parse Provider/Source
	if idx := strings.Index(xml, "Provider Name=\""); idx != -1 {
		end := strings.Index(xml[idx+15:], "\"")
		if end != -1 {
			entry.Source = xml[idx+15 : idx+15+end]
		}
	}

	// Parse TimeCreated
	if idx := strings.Index(xml, "TimeCreated SystemTime=\""); idx != -1 {
		end := strings.Index(xml[idx+24:], "\"")
		if end != -1 {
			timeStr := xml[idx+24 : idx+24+end]
			if t, err := time.Parse("2006-01-02T15:04:05.0000000Z", timeStr); err == nil {
				entry.TimeCreated = t
			} else if t, err := time.Parse("2006-01-02T15:04:05.000Z", timeStr); err == nil {
				entry.TimeCreated = t
			} else if t, err := time.Parse(time.RFC3339, timeStr); err == nil {
				entry.TimeCreated = t
			}
		}
	}

	// Parse Computer
	if idx := strings.Index(xml, "<Computer>"); idx != -1 {
		end := strings.Index(xml[idx:], "</Computer>")
		if end != -1 {
			entry.Computer = xml[idx+10 : idx+end]
		}
	}

	// Parse Task/Category
	if idx := strings.Index(xml, "<Task>"); idx != -1 {
		end := strings.Index(xml[idx:], "</Task>")
		if end != -1 {
			entry.Category = xml[idx+6 : idx+end]
		}
	}

	// Parse Security UserID
	if idx := strings.Index(xml, "Security UserID=\""); idx != -1 {
		end := strings.Index(xml[idx+17:], "\"")
		if end != -1 {
			entry.User = xml[idx+17 : idx+17+end]
		}
	}

	// Parse EventData
	if idx := strings.Index(xml, "<EventData>"); idx != -1 {
		end := strings.Index(xml[idx:], "</EventData>")
		if end != -1 {
			entry.Data = xml[idx+11 : idx+end]
		}
	}

	// For message, we'd need to use EvtFormatMessage which requires additional work
	// For now, use the event data or a placeholder
	if entry.Data != "" {
		entry.Message = extractDataValues(entry.Data)
	} else {
		entry.Message = fmt.Sprintf("Event ID %d from %s", entry.EventID, entry.Source)
	}

	return entry, nil
}

func levelToString(level int) string {
	switch level {
	case EvtLevelCritical:
		return EventLevelCritical
	case EvtLevelError:
		return EventLevelError
	case EvtLevelWarning:
		return EventLevelWarning
	case EvtLevelInformation:
		return EventLevelInformation
	case EvtLevelVerbose:
		return EventLevelVerbose
	default:
		return "Unknown"
	}
}

func extractDataValues(data string) string {
	var values []string

	// Extract values from <Data Name="...">value</Data> patterns
	remaining := data
	for {
		idx := strings.Index(remaining, "<Data")
		if idx == -1 {
			break
		}
		remaining = remaining[idx:]

		// Find the closing >
		closeTag := strings.Index(remaining, ">")
		if closeTag == -1 {
			break
		}

		// Find </Data>
		endTag := strings.Index(remaining, "</Data>")
		if endTag == -1 || endTag < closeTag {
			remaining = remaining[closeTag+1:]
			continue
		}

		value := strings.TrimSpace(remaining[closeTag+1 : endTag])
		if value != "" {
			values = append(values, value)
		}
		remaining = remaining[endTag+7:]
	}

	if len(values) > 0 {
		return strings.Join(values, "; ")
	}
	return ""
}

// GetEvent retrieves a specific event by record ID.
func (m *EventLogManager) GetEvent(logName string, recordId uint64) (*EventLogEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	logNamePtr, err := windows.UTF16PtrFromString(logName)
	if err != nil {
		return nil, fmt.Errorf("invalid log name: %w", err)
	}

	query := fmt.Sprintf("*[System[EventRecordID=%d]]", recordId)
	queryPtr, err := windows.UTF16PtrFromString(query)
	if err != nil {
		return nil, fmt.Errorf("invalid query: %w", err)
	}

	hQuery, _, err := procEvtQuery.Call(
		0,
		uintptr(unsafe.Pointer(logNamePtr)),
		uintptr(unsafe.Pointer(queryPtr)),
		EvtQueryChannelPath,
	)
	if hQuery == 0 {
		return nil, fmt.Errorf("failed to query log '%s': %w", logName, err)
	}
	defer procEvtClose.Call(hQuery)

	var eventHandle uintptr
	var returned uint32

	ret, _, _ := procEvtNext.Call(
		hQuery,
		1,
		uintptr(unsafe.Pointer(&eventHandle)),
		0,
		0,
		uintptr(unsafe.Pointer(&returned)),
	)

	if ret == 0 || returned == 0 || eventHandle == 0 {
		return nil, fmt.Errorf("event not found: recordId=%d", recordId)
	}
	defer procEvtClose.Call(eventHandle)

	return renderEvent(eventHandle)
}

// ClearLog clears the specified event log, optionally backing it up first.
func (m *EventLogManager) ClearLog(logName string, options *ClearLogOptions) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	logNamePtr, err := windows.UTF16PtrFromString(logName)
	if err != nil {
		return fmt.Errorf("invalid log name: %w", err)
	}

	var backupPathPtr *uint16
	if options != nil && options.BackupPath != "" {
		backupPathPtr, err = windows.UTF16PtrFromString(options.BackupPath)
		if err != nil {
			return fmt.Errorf("invalid backup path: %w", err)
		}
	}

	ret, _, err := procEvtClearLog.Call(
		0,
		uintptr(unsafe.Pointer(logNamePtr)),
		uintptr(unsafe.Pointer(backupPathPtr)),
		0,
	)

	if ret == 0 {
		// Check for access denied
		if errno, ok := err.(syscall.Errno); ok {
			if errno == windows.ERROR_ACCESS_DENIED {
				return fmt.Errorf("access denied: clearing '%s' requires administrator privileges", logName)
			}
		}
		return fmt.Errorf("failed to clear log '%s': %w", logName, err)
	}

	return nil
}
