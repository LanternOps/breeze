package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("audit")

// Event types for audit logging.
const (
	EventCommandReceived    = "command_received"
	EventCommandExecuted    = "command_executed"
	EventScriptExecution    = "script_execution"
	EventServiceAction      = "service_action"
	EventFileModification   = "file_modification"
	EventConfigChange       = "config_change"
	EventPrivilegedOp       = "privileged_operation"
	EventAgentStart         = "agent_start"
	EventAgentStop          = "agent_stop"
)

// Entry is a single audit log record.
type Entry struct {
	Timestamp  string         `json:"timestamp"`
	EventType  string         `json:"eventType"`
	CommandID  string         `json:"commandId,omitempty"`
	Details    map[string]any `json:"details,omitempty"`
	PrevHash   string         `json:"prevHash"`
	EntryHash  string         `json:"entryHash"`
}

// Logger writes tamper-evident JSONL audit logs with a SHA-256 hash chain.
type Logger struct {
	mu         sync.Mutex
	file       *os.File
	filePath   string
	maxSize    int64
	maxBackups int
	written    int64
	prevHash   string
}

// NewLogger creates an audit logger writing to {dataDir}/audit.jsonl.
func NewLogger(cfg *config.Config) (*Logger, error) {
	dataDir := config.GetDataDir()
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("create audit data dir: %w", err)
	}

	filePath := filepath.Join(dataDir, "audit.jsonl")

	maxSize := cfg.AuditMaxSizeMB
	if maxSize <= 0 {
		maxSize = 50
	}
	maxBackups := cfg.AuditMaxBackups
	if maxBackups <= 0 {
		maxBackups = 3
	}

	l := &Logger{
		filePath:   filePath,
		maxSize:    int64(maxSize) * 1024 * 1024,
		maxBackups: maxBackups,
		prevHash:   "genesis",
	}

	if err := l.openFile(); err != nil {
		return nil, err
	}

	log.Info("audit logger started", "path", filePath)
	return l, nil
}

// Log writes a single audit entry with hash chain linking.
// The hash chain is only advanced after a successful write to prevent corruption.
func (l *Logger) Log(eventType string, commandID string, details map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()

	entry := Entry{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		EventType: eventType,
		CommandID: commandID,
		Details:   details,
		PrevHash:  l.prevHash,
	}

	entryHash, err := l.computeHash(entry)
	if err != nil {
		log.Error("failed to compute audit entry hash", "error", err, "eventType", eventType)
		return
	}
	entry.EntryHash = entryHash

	data, err := json.Marshal(entry)
	if err != nil {
		log.Error("failed to marshal audit entry", "error", err, "eventType", eventType)
		return
	}
	data = append(data, '\n')

	if l.written+int64(len(data)) > l.maxSize {
		if err := l.rotate(); err != nil {
			log.Error("audit log rotation failed", "error", err)
			return
		}
	}

	n, err := l.file.Write(data)
	if err != nil {
		log.Error("failed to write audit entry", "error", err, "eventType", eventType)
		return
	}
	l.written += int64(n)

	// Only advance hash chain after successful write
	l.prevHash = entry.EntryHash
}

// Close flushes and closes the audit log file.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.file != nil {
		return l.file.Close()
	}
	return nil
}

func (l *Logger) computeHash(entry Entry) (string, error) {
	h := sha256.New()
	fmt.Fprintf(h, "%s|%s|%s|%s", entry.Timestamp, entry.EventType, entry.CommandID, entry.PrevHash)
	if entry.Details != nil {
		detailBytes, err := json.Marshal(entry.Details)
		if err != nil {
			return "", fmt.Errorf("marshal details for hash: %w", err)
		}
		h.Write(detailBytes)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (l *Logger) openFile() error {
	f, err := os.OpenFile(l.filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return fmt.Errorf("open audit log: %w", err)
	}

	info, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("stat audit log: %w", err)
	}

	l.file = f
	l.written = info.Size()
	return nil
}

func (l *Logger) rotate() error {
	if l.file != nil {
		l.file.Close()
	}

	// Shift existing backups: .3 → delete, .2 → .3, .1 → .2
	for i := l.maxBackups; i >= 2; i-- {
		src := l.backupName(i - 1)
		dst := l.backupName(i)
		if i == l.maxBackups {
			if err := os.Remove(dst); err != nil && !os.IsNotExist(err) {
				log.Warn("audit log rotation: failed to remove oldest backup", "path", dst, "error", err)
			}
		}
		if err := os.Rename(src, dst); err != nil && !os.IsNotExist(err) {
			log.Warn("audit log rotation: failed to rename backup", "src", src, "dst", dst, "error", err)
		}
	}

	// Rename current log to .1
	if err := os.Rename(l.filePath, l.backupName(1)); err != nil && !os.IsNotExist(err) {
		log.Warn("audit log rotation: failed to rename current log", "error", err)
	}
	return l.openFile()
}

func (l *Logger) backupName(index int) string {
	if index == 0 {
		return l.filePath
	}
	return fmt.Sprintf("%s.%d", l.filePath, index)
}
